import fs from "node:fs";
import net from "node:net";

import {
	BOOTSTRAP_CONFIG_ENV_VAR,
	shouldEmitUserIntervened,
	validateMonotonicSeqAcceptance,
	validateReportToParentInput,
	validateRuntimeBootstrapConfig,
	validateSidecarControlMessage,
	validateSidecarEventMessage,
	type RuntimeState,
	type RuntimeBootstrapConfig,
	type SidecarControlMessage,
	type SidecarEnvelope,
	type SidecarEventMessage,
	type ValidationOutcome,
} from "./contracts.js";

interface ExtensionContextLike {
	abort(): void;
	isIdle(): boolean;
	shutdown(): void;
}

interface ExtensionToolLike {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	execute: (...args: unknown[]) => Promise<unknown>;
}

interface ExtensionApiLike {
	on(
		event: "session_start" | "session_shutdown" | "agent_start" | "agent_end" | "input",
		handler: (event: unknown, ctx: ExtensionContextLike) => unknown | Promise<unknown>,
	): void;
	registerTool?(definition: ExtensionToolLike): void;
	sendUserMessage?(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

interface SocketLike {
	on(event: "connect", listener: () => void): this;
	on(event: "data", listener: (chunk: Buffer | string) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "close", listener: () => void): this;
	write(chunk: string): boolean;
	end(): void;
	destroy(error?: Error): void;
}

export interface SubagentBootstrapExtensionOptions {
	env?: Readonly<Record<string, string | undefined>>;
	connectSocket?: (socketPath: string) => SocketLike;
	readConfigText?: (configPath: string) => string;
	now?: () => string;
	pid?: () => number;
	handshakeTimeoutMs?: number;
	setTimeoutFn?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

function fail(error: string): ValidationOutcome<never> {
	return { ok: false, error };
}

function ok<T>(value: T): ValidationOutcome<T> {
	return { ok: true, value };
}

function normalizeError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	return new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractAssistantTextContent(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
		return undefined;
	}

	const parts = message.content
		.filter((entry): entry is Record<string, unknown> => isRecord(entry))
		.filter((entry) => entry.type === "text" && typeof entry.text === "string")
		.map((entry) => {
			const text = entry.text;
			return typeof text === "string" ? text.trim() : "";
		})
		.filter((entry) => entry.length > 0);
	if (parts.length === 0) {
		return undefined;
	}

	return parts.join("\n\n");
}

function extractFallbackFinalResult(event: unknown): { summary: string; data: unknown } | undefined {
	if (!isRecord(event) || !Array.isArray(event.messages)) {
		return undefined;
	}

	for (let index = event.messages.length - 1; index >= 0; index -= 1) {
		const text = extractAssistantTextContent(event.messages[index]);
		if (!text) {
			continue;
		}

		const firstLine = text
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.length > 0) ?? text;
		const summary = firstLine.length > 240
			? `${firstLine.slice(0, 237).trimEnd()}...`
			: firstLine;

		return {
			summary,
			data: text === summary ? null : { assistantText: text, synthesizedFrom: "agent_end" },
		};
	}

	return undefined;
}

function loadBootstrapConfig(
	env: Readonly<Record<string, string | undefined>>,
	readConfigText: (configPath: string) => string,
): ValidationOutcome<RuntimeBootstrapConfig | null> {
	const configPath = env[BOOTSTRAP_CONFIG_ENV_VAR];
	if (!configPath) {
		return ok(null);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readConfigText(configPath)) as unknown;
	} catch (error) {
		const reason = normalizeError(error).message;
		return fail(`bootstrap config could not be read: ${reason}`);
	}

	return validateRuntimeBootstrapConfig(parsed);
}

function registerReportTool(
	pi: ExtensionApiLike,
	getActiveSession: () => SubagentBootstrapSession | undefined,
): void {
	if (!pi.registerTool) {
		return;
	}

	pi.registerTool({
		name: "report_to_parent",
		label: "Report To Parent",
		description: "Reserved machine-facing reporting channel for tmux-backed subagents.",
		parameters: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					enum: ["progress", "final_result", "needs_input"],
				},
				summary: {
					type: "string",
				},
				data: {},
			},
			required: ["kind", "summary"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const activeSession = getActiveSession();
			if (!activeSession) {
				throw new Error("report_to_parent requires an active bootstrap session");
			}

			await activeSession.handleReportToolCall(params);
			return {
				content: [{ type: "text", text: "Reported to parent." }],
				details: undefined,
			};
		},
	});
}

class SubagentBootstrapSession {
	private readonly startupPromise: Promise<void>;

	private startupResolve!: () => void;

	private startupReject!: (error: Error) => void;

	private timeoutHandle: ReturnType<typeof setTimeout> | undefined;

	private closed = false;

	private ready = false;

	private currentState: RuntimeState = "connecting";

	private interruptPending = false;

	private lastParentSeq: number | undefined;

	private nextChildSeq = 0;

	private buffer = "";

	private terminalReportSentForCurrentTurn = false;

	private buildStartupFailure(error: Error, cleanupErrors: Error[]): Error {
		if (cleanupErrors.length === 0) {
			return error;
		}

		return new AggregateError(cleanupErrors, error.message);
	}

	public constructor(
		private readonly config: RuntimeBootstrapConfig,
		private readonly socket: SocketLike,
		private readonly pi: ExtensionApiLike,
		private ctx: ExtensionContextLike,
		private readonly options: Required<
			Pick<SubagentBootstrapExtensionOptions, "now" | "pid" | "handshakeTimeoutMs" | "setTimeoutFn" | "clearTimeoutFn">
		>,
	) {
		this.startupPromise = new Promise<void>((resolve, reject) => {
			this.startupResolve = resolve;
			this.startupReject = reject;
		});
	}

	public start(): Promise<void> {
		this.socket.on("data", (chunk) => {
			try {
				this.handleChunk(chunk);
			} catch (error) {
				this.failStartup(normalizeError(error));
			}
		});
		this.socket.on("error", (error) => {
			if (!this.ready) {
				this.failStartup(error);
			}
		});
		this.socket.on("close", () => {
			if (!this.ready && !this.closed) {
				this.failStartup(new Error("sidecar socket closed before ready"));
			}
		});

		this.timeoutHandle = this.options.setTimeoutFn(() => {
			if (!this.ready) {
				this.failStartup(new Error("child did not receive hello before timeout"));
			}
		}, this.options.handshakeTimeoutMs);

		return this.startupPromise;
	}

	public attachContext(ctx: ExtensionContextLike): void {
		this.ctx = ctx;
	}

	public waitUntilReady(): Promise<void> {
		return this.startupPromise;
	}

	public shutdown(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		this.clearTimeoutSafely();
		try {
			this.socket.end();
		} catch {
			// Best-effort shutdown during bootstrap lifecycle churn.
		}
	}

	public async handleReportToolCall(params: unknown): Promise<void> {
		if (!this.ready) {
			throw new Error("report_to_parent is not available before ready");
		}

		const reportResult = validateReportToParentInput(params, this.currentState);
		if (!reportResult.ok) {
			this.sendRecoverableError(reportResult.error);
			throw new Error(reportResult.error);
		}

		switch (reportResult.value.kind) {
			case "progress":
				this.sendEvent("progress", {
					summary: reportResult.value.summary,
					data: reportResult.value.data ?? null,
				});
				this.currentState = "running";
				return;
			case "final_result":
				this.sendEvent("final_result", {
					summary: reportResult.value.summary,
					data: reportResult.value.data ?? null,
				});
				this.terminalReportSentForCurrentTurn = true;
				return;
			case "needs_input":
				this.sendEvent("needs_input", {
					question: reportResult.value.summary,
					kind: "question",
				});
				this.currentState = "needs_input";
				this.terminalReportSentForCurrentTurn = true;
		}
	}

	public handleAgentStart(): void {
		if (!this.ready) {
			return;
		}

		this.terminalReportSentForCurrentTurn = false;
	}

	public handleAgentEnd(event: unknown): void {
		if (!this.ready) {
			return;
		}
		if (this.interruptPending) {
			this.completeInterrupt();
			return;
		}
		if (this.terminalReportSentForCurrentTurn) {
			return;
		}

		const fallbackResult = extractFallbackFinalResult(event);
		if (!fallbackResult) {
			return;
		}

		this.sendEvent("final_result", {
			summary: fallbackResult.summary,
			data: fallbackResult.data,
		});
		this.terminalReportSentForCurrentTurn = true;
	}

	public handleInput(event: unknown): void {
		if (!this.ready) {
			return;
		}
		if (!isRecord(event)) {
			return;
		}
		if (event.source !== "interactive" && event.source !== "rpc" && event.source !== "extension") {
			return;
		}

		// pi emits "input" only from submitted prompt paths, so interactive input
		// reaching this hook is already user-submitted rather than keystroke churn.
		const inputOrigin =
			event.source === "interactive"
				? { origin: "interactive-user" as const, submitted: true }
				: event.source === "rpc"
					? { origin: "system" as const, submitted: true }
					: { origin: "extension" as const, submitted: true };
		if (!shouldEmitUserIntervened(inputOrigin)) {
			return;
		}

		this.sendEvent("user_intervened", {
			source: "tmux",
			mode: "direct-chat",
		});
	}

	private handleChunk(chunk: Buffer | string): void {
		this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		while (true) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex < 0) {
				return;
			}

			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.length === 0) {
				continue;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(line) as unknown;
			} catch (error) {
				throw new Error(`invalid parent control message: ${normalizeError(error).message}`);
			}

			const messageResult = validateSidecarControlMessage(parsed);
			if (!messageResult.ok) {
				throw new Error(messageResult.error);
			}

			this.handleControl(messageResult.value);
		}
	}

	private handleControl(message: SidecarControlMessage): void {
		if (message.agentId !== this.config.agentId) {
			throw new Error("parent control agentId must match bootstrap agentId");
		}

		if (this.lastParentSeq !== undefined && message.seq <= this.lastParentSeq) {
			return;
		}

		const seqResult = validateMonotonicSeqAcceptance(message.seq, this.lastParentSeq);
		if (!seqResult.ok) {
			throw new Error(seqResult.error);
		}
		this.lastParentSeq = seqResult.value;

		if (!this.ready) {
			if (message.type !== "hello") {
				throw new Error(`expected hello before ready, received ${message.type}`);
			}

			this.acceptHello(message);
			return;
		}

		switch (message.type) {
			case "ping":
				this.sendEvent("pong", {});
				return;
			case "steer":
				this.deliverUserMessage(message.payload.message, "steer");
				return;
			case "follow_up":
				this.deliverUserMessage(message.payload.message, "followUp");
				return;
			case "interrupt":
				this.handleInterrupt();
				return;
			case "hello":
				throw new Error("hello has already been accepted for this child session");
		}
	}

	private acceptHello(message: SidecarEnvelope<"hello">): void {
		if (message.payload.sessionPath !== this.config.sessionPath) {
			throw new Error("hello sessionPath must match bootstrap sessionPath");
		}
		if (message.payload.tmuxTarget !== this.config.tmuxTarget) {
			throw new Error("hello tmuxTarget must match bootstrap tmuxTarget");
		}
		if (message.payload.mode !== this.config.tmuxMode) {
			throw new Error("hello mode must match bootstrap tmuxMode");
		}

		if (!this.pi.sendUserMessage) {
			throw new Error("pi.sendUserMessage must be available for bootstrap prompt injection");
		}
		this.pi.sendUserMessage(this.config.initialPrompt);

		this.sendEvent("ready", {
			pid: this.options.pid(),
			sessionPath: this.config.sessionPath,
			tmuxTarget: this.config.tmuxTarget,
		});
		this.ready = true;
		this.currentState = "ready";
		this.clearTimeoutSafely();
		this.startupResolve();
	}

	private deliverUserMessage(message: string, deliverAs: "steer" | "followUp"): void {
		if (!this.pi.sendUserMessage) {
			const error = "pi.sendUserMessage must be available for post-ready control delivery";
			this.sendRecoverableError(error);
			return;
		}

		try {
			this.pi.sendUserMessage(message, { deliverAs });
		} catch (error) {
			const reason = `failed to deliver ${deliverAs}: ${normalizeError(error).message}`;
			this.sendRecoverableError(reason);
			return;
		}
	}

	private handleInterrupt(): void {
		this.interruptPending = true;
		try {
			this.ctx.abort();
		} catch (error) {
			this.interruptPending = false;
			const reason = `failed to interrupt current work: ${normalizeError(error).message}`;
			this.sendRecoverableError(reason);
			return;
		}

		try {
			if (this.currentState === "needs_input" || this.ctx.isIdle()) {
				this.completeInterrupt();
			}
		} catch (error) {
			const reason = `failed to inspect child idle state after interrupt: ${normalizeError(error).message}`;
			this.sendRecoverableError(reason);
			return;
		}
	}

	private completeInterrupt(): void {
		if (!this.interruptPending) {
			return;
		}

		this.interruptPending = false;
		this.currentState = "waiting";
		this.sendEvent("state", {
			status: "waiting",
		});
	}

	private sendRecoverableError(message: string): void {
		if (!this.ready || this.closed) {
			return;
		}

		this.currentState = "failed";
		this.sendEvent("error", {
			message,
			fatal: false,
		});
	}

	private sendEvent(type: SidecarEventMessage["type"], payload: Record<string, unknown>): void {
		const eventResult = validateSidecarEventMessage({
			version: 1,
			agentId: this.config.agentId,
			type,
			seq: this.nextChildSeq,
			time: this.options.now(),
			payload,
		});
		if (!eventResult.ok) {
			throw new Error(eventResult.error);
		}

		this.socket.write(`${JSON.stringify(eventResult.value)}\n`);
		this.nextChildSeq = eventResult.value.seq + 1;
	}

	private failStartup(error: Error): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		const cleanupErrors: Error[] = [];
		const timeoutError = this.clearTimeoutSafely();
		if (timeoutError) {
			cleanupErrors.push(timeoutError);
		}
		try {
			this.socket.destroy(error);
		} catch (destroyError) {
			cleanupErrors.push(normalizeError(destroyError));
		}
		try {
			this.ctx.shutdown();
		} catch (shutdownError) {
			cleanupErrors.push(normalizeError(shutdownError));
		}
		this.startupReject(this.buildStartupFailure(error, cleanupErrors));
	}

	private clearTimeoutSafely(): Error | undefined {
		if (this.timeoutHandle === undefined) {
			return undefined;
		}

		const handle = this.timeoutHandle;
		this.timeoutHandle = undefined;
		try {
			this.options.clearTimeoutFn(handle);
			return undefined;
		} catch (error) {
			return normalizeError(error);
		}
	}
}

export function installSubagentBootstrapExtension(
	pi: ExtensionApiLike,
	options: SubagentBootstrapExtensionOptions = {},
): void {
	const env = options.env ?? process.env;
	const connectSocket = options.connectSocket ?? ((socketPath: string) => net.createConnection(socketPath));
	const readConfigText = options.readConfigText ?? ((configPath: string) => fs.readFileSync(configPath, "utf8"));
	const now = options.now ?? (() => new Date().toISOString());
	const pid = options.pid ?? (() => process.pid);
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 30_000;
	const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;

	let activeSession: SubagentBootstrapSession | undefined;
	let reportToolRegistered = false;

	pi.on("session_start", async (_event, ctx) => {
		const configResult = loadBootstrapConfig(env, readConfigText);
		if (!configResult.ok) {
			throw new Error(configResult.error);
		}
		if (!configResult.value) {
			return;
		}

		if (!reportToolRegistered) {
			registerReportTool(pi, () => activeSession);
			reportToolRegistered = true;
		}

		if (activeSession) {
			activeSession.attachContext(ctx);
			await activeSession.waitUntilReady();
			return;
		}

		const socket = connectSocket(configResult.value.socketPath);
		const session = new SubagentBootstrapSession(
			configResult.value,
			socket,
			pi,
			ctx,
			{
				now,
				pid,
				handshakeTimeoutMs,
				setTimeoutFn,
				clearTimeoutFn,
			},
		);
		activeSession = session;
		try {
			await session.start();
		} catch (error) {
			if (activeSession === session) {
				activeSession = undefined;
			}
			throw error;
		}
	});

	pi.on("agent_start", async () => {
		activeSession?.handleAgentStart();
	});

	pi.on("agent_end", async (event) => {
		activeSession?.handleAgentEnd(event);
	});

	pi.on("input", async (event) => {
		activeSession?.handleInput(event);
	});

	pi.on("session_shutdown", async () => {
		// Bootstrap ownership is process-scoped for RAT-134 bring-up. The real
		// pi runtime emits lifecycle churn during startup, so we keep the socket
		// session alive here and let process exit close it.
	});
}

export default function bootstrapSubagentExtension(pi: ExtensionApiLike): void {
	installSubagentBootstrapExtension(pi);
}
