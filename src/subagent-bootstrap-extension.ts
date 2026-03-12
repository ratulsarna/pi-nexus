import fs from "node:fs";
import net from "node:net";

import {
	BOOTSTRAP_CONFIG_ENV_VAR,
	validateMonotonicSeqAcceptance,
	validateReportToParentInput,
	validateRuntimeBootstrapConfig,
	validateSidecarControlMessage,
	validateSidecarEventMessage,
	type RuntimeBootstrapConfig,
	type SidecarControlMessage,
	type SidecarEnvelope,
	type SidecarEventMessage,
	type ValidationOutcome,
} from "./contracts.js";

interface ExtensionContextLike {
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
	on(event: "session_start" | "session_shutdown", handler: (event: unknown, ctx: ExtensionContextLike) => unknown | Promise<unknown>): void;
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

function registerReportTool(pi: ExtensionApiLike): void {
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
			const reportResult = validateReportToParentInput(params, "ready", false);
			if (!reportResult.ok) {
				throw new Error(reportResult.error);
			}

			throw new Error("report_to_parent is reserved for post-ready lifecycle work in RAT-135");
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

	private lastParentSeq: number | undefined;

	private nextChildSeq = 0;

	private buffer = "";

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
		this.clearTimeout();
		this.socket.end();
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

		if (message.type === "ping") {
			this.sendEvent("pong", {});
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
		this.clearTimeout();
		this.startupResolve();
	}

	private sendEvent<TType extends Extract<SidecarEventMessage["type"], "ready" | "pong">>(
		type: TType,
		payload: SidecarEventMessage["payload"] & Record<string, unknown>,
	): void {
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
		this.clearTimeout();
		this.socket.destroy(error);
		this.ctx.shutdown();
		this.startupReject(error);
	}

	private clearTimeout(): void {
		if (this.timeoutHandle === undefined) {
			return;
		}

		this.options.clearTimeoutFn(this.timeoutHandle);
		this.timeoutHandle = undefined;
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
			registerReportTool(pi);
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

	pi.on("session_shutdown", async () => {
		// Bootstrap ownership is process-scoped for RAT-134 bring-up. The real
		// pi runtime emits lifecycle churn during startup, so we keep the socket
		// session alive here and let process exit close it.
	});
}

export default function bootstrapSubagentExtension(pi: ExtensionApiLike): void {
	installSubagentBootstrapExtension(pi);
}
