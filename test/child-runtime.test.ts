import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BOOTSTRAP_CONFIG_ENV_VAR, type RuntimeBootstrapConfig } from "../src/contracts.js";
import { NodeSidecarSessionAdapter } from "../src/node-runtime-adapters.js";
import { installSubagentBootstrapExtension } from "../src/subagent-bootstrap-extension.js";

type ExtensionHandler = (event: unknown, ctx: FakeExtensionContext) => unknown | Promise<unknown>;

class FakeSocket extends EventEmitter {
	public readonly writes: string[] = [];
	public ended = false;
	public destroyed = false;
	public destroyedWith: Error | undefined;

	public constructor(
		private readonly options: {
			throwOnDestroy?: Error;
			throwOnEnd?: Error;
		} = {},
	) {
		super();
	}

	public override on(event: string, listener: (...args: unknown[]) => void): this {
		return super.on(event, listener);
	}

	public write(chunk: string): boolean {
		this.writes.push(chunk);
		return true;
	}

	public end(): this {
		this.ended = true;
		if (this.options.throwOnEnd) {
			throw this.options.throwOnEnd;
		}
		this.emit("close");
		return this;
	}

	public destroy(error?: Error): this {
		this.destroyed = true;
		this.destroyedWith = error;
		if (this.options.throwOnDestroy) {
			throw this.options.throwOnDestroy;
		}
		this.emit("close");
		return this;
	}

	public connect(): void {
		this.emit("connect");
	}

	public receive(message: Record<string, unknown>): void {
		this.emit("data", Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
	}

	public receiveRaw(line: string): void {
		this.emit("data", Buffer.from(line, "utf8"));
	}
}

class FakeExtensionContext {
	public shutdownCalls = 0;
	public abortCalls = 0;
	public idle = true;

	public constructor(
		private readonly options: {
			onAbort?: () => void;
			throwOnAbort?: Error;
			throwOnIsIdle?: Error;
			throwOnShutdown?: Error;
		} = {},
	) {}

	public abort(): void {
		this.abortCalls += 1;
		this.options.onAbort?.();
		if (this.options.throwOnAbort) {
			throw this.options.throwOnAbort;
		}
	}

	public isIdle(): boolean {
		if (this.options.throwOnIsIdle) {
			throw this.options.throwOnIsIdle;
		}

		return this.idle;
	}

	public shutdown(): void {
		this.shutdownCalls += 1;
		if (this.options.throwOnShutdown) {
			throw this.options.throwOnShutdown;
		}
	}
}

class FakePiApi {
	public readonly handlers = new Map<string, ExtensionHandler[]>();
	public readonly registeredTools: Array<Record<string, unknown>> = [];
	public readonly sentUserMessages: string[] = [];
	public readonly sentUserMessageCalls: Array<{
		content: string;
		options?: { deliverAs?: "steer" | "followUp" };
	}> = [];

	public on(event: string, handler: ExtensionHandler): void {
		const existing = this.handlers.get(event) ?? [];
		existing.push(handler);
		this.handlers.set(event, existing);
	}

	public registerTool(definition: Record<string, unknown>): void {
		this.registeredTools.push(definition);
	}

	public sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void {
		this.sentUserMessages.push(content);
		this.sentUserMessageCalls.push({ content, options });
	}

	public async emit(event: string, payload: unknown, ctx: FakeExtensionContext): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}
}

function makeBootstrap(agentId: string, runtimeDir: string, extensionPath: string): RuntimeBootstrapConfig {
	return {
		agentId,
		sessionPath: path.join(runtimeDir, `${agentId}.session.jsonl`),
		socketPath: path.join(runtimeDir, `${agentId}.sock`),
		tmuxMode: "window",
		tmuxTarget: `${agentId}:child`,
		initialPrompt: `Initial prompt for ${agentId}`,
		bootstrapExtensionPath: extensionPath,
		cwd: runtimeDir,
		childMode: "interactive-cli",
	};
}

function parseSentEnvelopes(socket: FakeSocket): Array<Record<string, unknown>> {
	return socket.writes.map((entry) => JSON.parse(entry.trim()) as Record<string, unknown>);
}

function getReportTool(pi: FakePiApi): { execute: (...args: unknown[]) => Promise<unknown> } {
	const tool = pi.registeredTools.find((entry) => entry.name === "report_to_parent");
	if (!tool) {
		throw new Error("expected report_to_parent tool to be registered");
	}

	return tool as { execute: (...args: unknown[]) => Promise<unknown> };
}

async function startReadyBootstrapSession(agentId: string, timestamp: string): Promise<{
	bootstrap: RuntimeBootstrapConfig;
	socket: FakeSocket;
	pi: FakePiApi;
	ctx: FakeExtensionContext;
}> {
	const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
	const bootstrap = makeBootstrap(agentId, runtimeDir, fakeExtensionPath);
	const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
	fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

	const socket = new FakeSocket();
	const pi = new FakePiApi();
	const ctx = new FakeExtensionContext();
	installSubagentBootstrapExtension(pi, {
		env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
		connectSocket: () => socket,
		now: () => timestamp,
		pid: () => 7777,
	});

	const sessionStart = pi.emit("session_start", {}, ctx);
	socket.connect();
	socket.receive({
		version: 1,
		agentId: bootstrap.agentId,
		type: "hello",
		seq: 0,
		time: "2026-03-12T10:09:01.000Z",
		payload: {
			sessionPath: bootstrap.sessionPath,
			tmuxTarget: bootstrap.tmuxTarget,
			mode: bootstrap.tmuxMode,
		},
	});
	await sessionStart;

	return {
		bootstrap,
		socket,
		pi,
		ctx,
	};
}

let fakeRepoDir = os.tmpdir();
let fakeExtensionPath = path.join(os.tmpdir(), "bootstrap-extension.ts");

beforeAll(() => {
	fakeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-child-runtime-"));
	fakeExtensionPath = path.join(fakeRepoDir, "bootstrap-extension.ts");
	fs.writeFileSync(fakeExtensionPath, "export {};\n");
});

afterAll(() => {
	fs.rmSync(fakeRepoDir, { recursive: true, force: true });
});

describe("installSubagentBootstrapExtension", () => {
	it("completes hello -> ready, injects the initial prompt, and registers report_to_parent", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrap = makeBootstrap("agt_child_ready", runtimeDir, fakeExtensionPath);
		const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

		const socket = new FakeSocket();
		const pi = new FakePiApi();
		const ctx = new FakeExtensionContext();
		installSubagentBootstrapExtension(pi, {
			env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
			connectSocket: () => socket,
			now: () => "2026-03-12T10:00:00.000Z",
			pid: () => 4242,
		});

		const sessionStart = pi.emit("session_start", {}, ctx);
		socket.connect();
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "hello",
			seq: 0,
			time: "2026-03-12T10:00:01.000Z",
			payload: {
				sessionPath: bootstrap.sessionPath,
				tmuxTarget: bootstrap.tmuxTarget,
				mode: bootstrap.tmuxMode,
			},
		});
		await sessionStart;

		expect(pi.registeredTools).toHaveLength(1);
		expect(pi.registeredTools[0]?.name).toBe("report_to_parent");
		expect(pi.sentUserMessages).toEqual([bootstrap.initialPrompt]);

		const sent = parseSentEnvelopes(socket);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.type).toBe("ready");
		expect(sent[0]?.seq).toBe(0);
		expect(sent[0]?.payload).toEqual({
			pid: 4242,
			sessionPath: bootstrap.sessionPath,
			tmuxTarget: bootstrap.tmuxTarget,
		});
		expect(ctx.shutdownCalls).toBe(0);
	});

	it("still settles startup successfully if ready-path timer cleanup throws", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrap = makeBootstrap("agt_child_ready_cleanup", runtimeDir, fakeExtensionPath);
		const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

		const socket = new FakeSocket();
		const pi = new FakePiApi();
		const ctx = new FakeExtensionContext();
		installSubagentBootstrapExtension(pi, {
			env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
			connectSocket: () => socket,
			now: () => "2026-03-12T10:00:30.000Z",
			pid: () => 4343,
			clearTimeoutFn: () => {
				throw new Error("clear timeout exploded");
			},
		});

		const sessionStart = pi.emit("session_start", {}, ctx);
		socket.connect();
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "hello",
			seq: 0,
			time: "2026-03-12T10:00:31.000Z",
			payload: {
				sessionPath: bootstrap.sessionPath,
				tmuxTarget: bootstrap.tmuxTarget,
				mode: bootstrap.tmuxMode,
			},
		});
		await sessionStart;

		expect(pi.sentUserMessages).toEqual([bootstrap.initialPrompt]);
		expect(parseSentEnvelopes(socket).map((message) => message.type)).toEqual(["ready"]);
		expect(ctx.shutdownCalls).toBe(0);
	});

	it("responds to ping after ready and ignores duplicate parent ping seq", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrap = makeBootstrap("agt_child_ping", runtimeDir, fakeExtensionPath);
		const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

		const socket = new FakeSocket();
		const pi = new FakePiApi();
		const ctx = new FakeExtensionContext();
		installSubagentBootstrapExtension(pi, {
			env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
			connectSocket: () => socket,
			now: () => "2026-03-12T10:01:00.000Z",
			pid: () => 5151,
		});

		const sessionStart = pi.emit("session_start", {}, ctx);
		socket.connect();
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "hello",
			seq: 0,
			time: "2026-03-12T10:01:01.000Z",
			payload: {
				sessionPath: bootstrap.sessionPath,
				tmuxTarget: bootstrap.tmuxTarget,
				mode: bootstrap.tmuxMode,
			},
		});
		await sessionStart;

		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "ping",
			seq: 1,
			time: "2026-03-12T10:01:02.000Z",
			payload: {},
		});
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "ping",
			seq: 1,
			time: "2026-03-12T10:01:03.000Z",
			payload: {},
		});

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "pong"]);
		expect(sent.map((message) => message.seq)).toEqual([0, 1]);
		expect(ctx.shutdownCalls).toBe(0);
	});

	it("forwards live report_to_parent progress and final_result events after ready", async () => {
		const { socket, pi } = await startReadyBootstrapSession(
			"agt_child_report_events",
			"2026-03-12T10:09:00.000Z",
		);

		const reportTool = getReportTool(pi);
		await reportTool.execute("call-progress", {
			kind: "progress",
			summary: "Working through the task",
			data: { step: 1 },
		});
		await reportTool.execute("call-final", {
			kind: "final_result",
			summary: "Completed the task",
			data: { status: "done" },
		});

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "progress", "final_result"]);
		expect(sent.map((message) => message.seq)).toEqual([0, 1, 2]);
		expect(sent[1]?.payload).toEqual({
			summary: "Working through the task",
			data: { step: 1 },
		});
		expect(sent[2]?.payload).toEqual({
			summary: "Completed the task",
			data: { status: "done" },
		});
	});

	it("synthesizes a final_result from assistant output on agent_end when the child does not report explicitly", async () => {
		const { socket, pi, ctx } = await startReadyBootstrapSession(
			"agt_child_agent_end_fallback",
			"2026-03-12T10:09:05.000Z",
		);

		await pi.emit("agent_start", {}, ctx);
		await pi.emit("agent_end", {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Done. Hi from the child agent." },
					],
				},
			],
		}, ctx);

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "final_result"]);
		expect(sent[1]?.payload).toEqual({
			summary: "Done. Hi from the child agent.",
			data: null,
		});
	});

	it("does not synthesize a duplicate final_result on agent_end after an explicit terminal report", async () => {
		const { socket, pi, ctx } = await startReadyBootstrapSession(
			"agt_child_agent_end_no_duplicate",
			"2026-03-12T10:09:06.000Z",
		);

		const reportTool = getReportTool(pi);
		await pi.emit("agent_start", {}, ctx);
		await reportTool.execute("call-final", {
			kind: "final_result",
			summary: "Completed the task",
			data: { status: "done" },
		});
		await pi.emit("agent_end", {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Completed the task" },
					],
				},
			],
		}, ctx);

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "final_result"]);
	});

	it("routes post-ready steer and follow_up through pi sendUserMessage", async () => {
		const { bootstrap, socket, pi } = await startReadyBootstrapSession(
			"agt_child_controls",
			"2026-03-12T10:09:10.000Z",
		);

		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "steer",
			seq: 1,
			time: "2026-03-12T10:09:11.000Z",
			payload: {
				message: "Adjust course",
			},
		});
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "follow_up",
			seq: 2,
			time: "2026-03-12T10:09:12.000Z",
			payload: {
				message: "Continue from the last result",
			},
		});

		expect(pi.sentUserMessageCalls).toEqual([
			{ content: bootstrap.initialPrompt, options: undefined },
			{ content: "Adjust course", options: { deliverAs: "steer" } },
			{ content: "Continue from the last result", options: { deliverAs: "followUp" } },
		]);
		expect(parseSentEnvelopes(socket).map((message) => message.type)).toEqual(["ready"]);
	});

	it("waits for child-authored agent_end before publishing waiting after interrupting active work", async () => {
		const { bootstrap, socket, pi, ctx } = await startReadyBootstrapSession(
			"agt_child_interrupt_running",
			"2026-03-12T10:09:20.000Z",
		);

		ctx.idle = false;
		const reportTool = getReportTool(pi);
		await reportTool.execute("call-progress", {
			kind: "progress",
			summary: "Still working",
		});

		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "interrupt",
			seq: 1,
			time: "2026-03-12T10:09:21.000Z",
			payload: {},
		});

		expect(ctx.abortCalls).toBe(1);
		expect(parseSentEnvelopes(socket).map((message) => message.type)).toEqual(["ready", "progress"]);

		await pi.emit("agent_end", {}, ctx);

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "progress", "state"]);
		expect(sent[2]?.payload).toEqual({
			status: "waiting",
		});
		expect(socket.ended).toBe(false);
		expect(socket.destroyed).toBe(false);
	});

	it("does not lose waiting when agent_end fires synchronously during abort", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrap = makeBootstrap("agt_child_interrupt_sync_end", runtimeDir, fakeExtensionPath);
		const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

		const socket = new FakeSocket();
		const pi = new FakePiApi();
		const ctx = new FakeExtensionContext({
			onAbort: () => {
				void pi.emit("agent_end", {}, ctx);
			},
		});
		installSubagentBootstrapExtension(pi, {
			env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
			connectSocket: () => socket,
			now: () => "2026-03-12T10:09:25.000Z",
			pid: () => 8888,
		});

		const sessionStart = pi.emit("session_start", {}, ctx);
		socket.connect();
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "hello",
			seq: 0,
			time: "2026-03-12T10:09:26.000Z",
			payload: {
				sessionPath: bootstrap.sessionPath,
				tmuxTarget: bootstrap.tmuxTarget,
				mode: bootstrap.tmuxMode,
			},
		});
		await sessionStart;

		ctx.idle = false;
		const reportTool = getReportTool(pi);
		await reportTool.execute("call-progress", {
			kind: "progress",
			summary: "Still working",
		});

		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "interrupt",
			seq: 1,
			time: "2026-03-12T10:09:27.000Z",
			payload: {},
		});

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "progress", "state"]);
		expect(sent[2]?.payload).toEqual({
			status: "waiting",
		});
		expect(ctx.abortCalls).toBe(1);
		expect(socket.ended).toBe(false);
		expect(socket.destroyed).toBe(false);
	});

	it("clears a pending input posture to waiting only after the child handles interrupt", async () => {
		const { bootstrap, socket, pi, ctx } = await startReadyBootstrapSession(
			"agt_child_interrupt_needs_input",
			"2026-03-12T10:09:30.000Z",
		);

		const reportTool = getReportTool(pi);
		await reportTool.execute("call-needs-input", {
			kind: "needs_input",
			summary: "Need approval",
		});

		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "interrupt",
			seq: 1,
			time: "2026-03-12T10:09:31.000Z",
			payload: {},
		});

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "needs_input", "state"]);
		expect(sent[1]?.payload).toEqual({
			question: "Need approval",
			kind: "question",
		});
		expect(sent[2]?.payload).toEqual({
			status: "waiting",
		});
		expect(ctx.abortCalls).toBe(1);
		expect(socket.ended).toBe(false);
		expect(socket.destroyed).toBe(false);
	});

	it.each([
		["steer", "failed to deliver steer: delivery exploded"],
		["follow_up", "failed to deliver followUp: delivery exploded"],
	] as const)(
		"keeps the post-ready session alive when %s delivery fails recoverably",
		async (type, expectedMessage) => {
			const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
			const bootstrap = makeBootstrap(`agt_child_${type}_recoverable_error`, runtimeDir, fakeExtensionPath);
			const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
			fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

			const socket = new FakeSocket();
			const pi = new FakePiApi();
			(pi as unknown as { sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => void }).sendUserMessage = (
				content: string,
				options?: { deliverAs?: "steer" | "followUp" },
			) => {
				if (content === bootstrap.initialPrompt) {
					pi.sentUserMessages.push(content);
					pi.sentUserMessageCalls.push({ content, options });
					return;
				}

				throw new Error("delivery exploded");
			};
			const ctx = new FakeExtensionContext();
			installSubagentBootstrapExtension(pi, {
				env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
				connectSocket: () => socket,
				now: () => "2026-03-12T10:09:35.000Z",
				pid: () => 9999,
			});

			const sessionStart = pi.emit("session_start", {}, ctx);
			socket.connect();
			socket.receive({
				version: 1,
				agentId: bootstrap.agentId,
				type: "hello",
				seq: 0,
				time: "2026-03-12T10:09:36.000Z",
				payload: {
					sessionPath: bootstrap.sessionPath,
					tmuxTarget: bootstrap.tmuxTarget,
					mode: bootstrap.tmuxMode,
				},
			});
			await sessionStart;

			socket.receive({
				version: 1,
				agentId: bootstrap.agentId,
				type,
				seq: 1,
				time: "2026-03-12T10:09:37.000Z",
				payload: {
					message: "Adjust course",
				},
			});

			const sent = parseSentEnvelopes(socket);
			expect(sent.map((message) => message.type)).toEqual(["ready", "error"]);
			expect(sent[1]?.payload).toEqual({
				message: expectedMessage,
				fatal: false,
			});
			expect(ctx.shutdownCalls).toBe(0);
			expect(socket.ended).toBe(false);
			expect(socket.destroyed).toBe(false);
		},
	);

	it("keeps the post-ready session alive when interrupt abort fails recoverably", async () => {
		const { bootstrap, socket, pi } = await startReadyBootstrapSession(
			"agt_child_interrupt_recoverable_error",
			"2026-03-12T10:09:45.000Z",
		);
		const ctx = new FakeExtensionContext({
			throwOnAbort: new Error("abort exploded"),
		});
		await pi.emit("session_start", {}, ctx);

		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "interrupt",
			seq: 1,
			time: "2026-03-12T10:09:46.000Z",
			payload: {},
		});

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "error"]);
		expect(sent[1]?.payload).toEqual({
			message: "failed to interrupt current work: abort exploded",
			fatal: false,
		});
		expect(ctx.abortCalls).toBe(1);
		expect(ctx.shutdownCalls).toBe(0);
		expect(socket.ended).toBe(false);
		expect(socket.destroyed).toBe(false);
	});

	it("emits user_intervened only for interactive input events", async () => {
		const { socket, pi, ctx } = await startReadyBootstrapSession(
			"agt_child_user_intervened",
			"2026-03-12T10:09:40.000Z",
		);

		await pi.emit("input", { source: "rpc" }, ctx);
		await pi.emit("input", { source: "extension" }, ctx);
		await pi.emit("input", { source: "interactive" }, ctx);

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "user_intervened"]);
		expect(sent[1]?.payload).toEqual({
			source: "tmux",
			mode: "direct-chat",
		});
	});

	it("ignores malformed input event payloads without breaking the post-ready session", async () => {
		const { socket, pi, ctx } = await startReadyBootstrapSession(
			"agt_child_malformed_input_event",
			"2026-03-12T10:09:42.000Z",
		);

		await pi.emit("input", null, ctx);
		await pi.emit("input", 42, ctx);
		await pi.emit("input", { source: "unknown" }, ctx);
		await pi.emit("input", { source: "interactive" }, ctx);

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "user_intervened"]);
		expect(ctx.shutdownCalls).toBe(0);
		expect(socket.ended).toBe(false);
		expect(socket.destroyed).toBe(false);
	});

	it("keeps the post-ready session alive when interrupt idle probing fails recoverably", async () => {
		const { bootstrap, socket, pi } = await startReadyBootstrapSession(
			"agt_child_interrupt_idle_probe_error",
			"2026-03-12T10:09:44.000Z",
		);
		const ctx = new FakeExtensionContext({
			throwOnIsIdle: new Error("idle probe exploded"),
		});
		await pi.emit("session_start", {}, ctx);

		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "interrupt",
			seq: 1,
			time: "2026-03-12T10:09:45.000Z",
			payload: {},
		});

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "error"]);
		expect(sent[1]?.payload).toEqual({
			message: "failed to inspect child idle state after interrupt: idle probe exploded",
			fatal: false,
		});
		expect(ctx.abortCalls).toBe(1);
		expect(ctx.shutdownCalls).toBe(0);
		expect(socket.ended).toBe(false);
		expect(socket.destroyed).toBe(false);
	});

	it("retains interrupt completion fallback when idle probing fails before a later agent_end", async () => {
		const { bootstrap, socket, pi } = await startReadyBootstrapSession(
			"agt_child_interrupt_idle_probe_then_end",
			"2026-03-12T10:09:44.500Z",
		);
		const ctx = new FakeExtensionContext({
			throwOnIsIdle: new Error("idle probe exploded"),
		});
		await pi.emit("session_start", {}, ctx);

		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "interrupt",
			seq: 1,
			time: "2026-03-12T10:09:45.500Z",
			payload: {},
		});

		await pi.emit("agent_end", {}, ctx);

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "error", "state"]);
		expect(sent[1]?.payload).toEqual({
			message: "failed to inspect child idle state after interrupt: idle probe exploded",
			fatal: false,
		});
		expect(sent[2]?.payload).toEqual({
			status: "waiting",
		});
		expect(ctx.abortCalls).toBe(1);
		expect(ctx.shutdownCalls).toBe(0);
		expect(socket.ended).toBe(false);
		expect(socket.destroyed).toBe(false);
	});

	it("surfaces a recoverable error when a malformed report arrives after ready", async () => {
		const { socket, pi } = await startReadyBootstrapSession(
			"agt_child_report_error",
			"2026-03-12T10:09:50.000Z",
		);

		const reportTool = getReportTool(pi);
		await expect(
			reportTool.execute("call-invalid", {
				kind: "progress",
				summary: "   ",
			}),
		).rejects.toThrow("summary must be a non-empty string");

		const sent = parseSentEnvelopes(socket);
		expect(sent.map((message) => message.type)).toEqual(["ready", "error"]);
		expect(sent[1]?.payload).toEqual({
			message: "summary must be a non-empty string",
			fatal: false,
		});
	});

	it("keeps the post-ready bootstrap session alive across session_shutdown churn", async () => {
		const { socket, pi, ctx } = await startReadyBootstrapSession(
			"agt_child_post_ready_shutdown",
			"2026-03-12T10:10:00.000Z",
		);

		await pi.emit("session_shutdown", {}, ctx);

		expect(parseSentEnvelopes(socket).map((message) => message.type)).toEqual(["ready"]);
		expect(socket.ended).toBe(false);
		expect(socket.destroyed).toBe(false);
		expect(ctx.shutdownCalls).toBe(0);
	});

	it("keeps one durable bootstrap session across startup lifecycle churn", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrap = makeBootstrap("agt_child_churn", runtimeDir, fakeExtensionPath);
		const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

		const socket = new FakeSocket();
		const connectSocket = vi.fn(() => socket);
		const pi = new FakePiApi();
		const firstCtx = new FakeExtensionContext();
		const secondCtx = new FakeExtensionContext();
		installSubagentBootstrapExtension(pi, {
			env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
			connectSocket,
			now: () => "2026-03-12T10:01:30.000Z",
			pid: () => 5252,
		});

		const firstStart = pi.emit("session_start", {}, firstCtx);
		await pi.emit("session_shutdown", {}, firstCtx);
		const secondStart = pi.emit("session_start", {}, secondCtx);

		socket.connect();
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "hello",
			seq: 0,
			time: "2026-03-12T10:01:31.000Z",
			payload: {
				sessionPath: bootstrap.sessionPath,
				tmuxTarget: bootstrap.tmuxTarget,
				mode: bootstrap.tmuxMode,
			},
		});
		await Promise.all([firstStart, secondStart]);

		expect(connectSocket).toHaveBeenCalledTimes(1);
		expect(pi.sentUserMessages).toEqual([bootstrap.initialPrompt]);
		expect(parseSentEnvelopes(socket).map((message) => message.type)).toEqual(["ready"]);
		expect(firstCtx.shutdownCalls).toBe(0);
		expect(secondCtx.shutdownCalls).toBe(0);
	});

	it("completes the real socket path through the Node sidecar adapter and answers pong", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnx-sock-"));
		const bootstrap = makeBootstrap("agt_child_socket", runtimeDir, fakeExtensionPath);
		const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

		const observedInbound: Array<Record<string, unknown>> = [];
		let sidecarHandle: { send(message: Record<string, unknown>): void; close(): void } | undefined;
		let pongResolve!: () => void;
		const pongSeen = new Promise<void>((resolve) => {
			pongResolve = resolve;
		});
		const adapter = new NodeSidecarSessionAdapter({
			onEnvelope(direction, message) {
				if (direction === "child_to_parent") {
					observedInbound.push(message as Record<string, unknown>);
					if ((message as Record<string, unknown>).type === "pong") {
						pongResolve();
					}
				}
			},
		});
		sidecarHandle = adapter.openSession(bootstrap.socketPath, {
			onConnect() {
				sidecarHandle?.send({
					version: 1,
					agentId: bootstrap.agentId,
					type: "hello",
					seq: 0,
					time: "2026-03-12T10:01:01.000Z",
					payload: {
						sessionPath: bootstrap.sessionPath,
						tmuxTarget: bootstrap.tmuxTarget,
						mode: bootstrap.tmuxMode,
					},
				});
				return { ok: true, value: undefined };
			},
			onMessage(message) {
				const envelope = message as Record<string, unknown>;
				if (envelope.type === "ready") {
					sidecarHandle?.send({
						version: 1,
						agentId: bootstrap.agentId,
						type: "ping",
						seq: 1,
						time: "2026-03-12T10:01:02.000Z",
						payload: {},
					});
				}
				return { ok: true, value: undefined };
			},
			onDisconnect() {
				return { ok: true, value: undefined };
			},
		});

		const pi = new FakePiApi();
		const ctx = new FakeExtensionContext();
		installSubagentBootstrapExtension(pi, {
			env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
			now: () => "2026-03-12T10:01:00.000Z",
			pid: () => 6006,
		});

		await pi.emit("session_start", {}, ctx);
		await pongSeen;

		expect(pi.sentUserMessages).toEqual([bootstrap.initialPrompt]);
		expect(observedInbound.map((message) => message.type)).toEqual(["ready", "pong"]);
		sidecarHandle.close();
	});

	it("allows the Node sidecar adapter to accept a reconnect on the same socket path", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnx-sock-reconnect-"));
		const socketPath = path.join(runtimeDir, "sidecar.sock");
		const connectEvents: string[] = [];
		const disconnectEvents: Array<string | undefined> = [];
		const adapter = new NodeSidecarSessionAdapter();
		const sessionHandle = adapter.openSession(socketPath, {
			onConnect() {
				connectEvents.push("connect");
				return { ok: true, value: undefined };
			},
			onMessage() {
				return { ok: true, value: undefined };
			},
			onDisconnect(reason) {
				disconnectEvents.push(reason);
				return { ok: true, value: undefined };
			},
		});

		const firstSocket = net.createConnection(socketPath);
		await waitForSocketConnect(firstSocket);
		firstSocket.end();
		await waitFor(() => disconnectEvents.length === 1);

		const secondSocket = net.createConnection(socketPath);
		await waitForSocketConnect(secondSocket);
		secondSocket.end();
		await waitFor(() => disconnectEvents.length === 2);

		expect(connectEvents).toHaveLength(2);
		expect(disconnectEvents).toEqual([undefined, undefined]);
		sessionHandle.close();
	});

	it("clears any partial child frame before accepting a reconnect on the same socket path", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnx-sock-reconnect-buffer-"));
		const socketPath = path.join(runtimeDir, "sidecar.sock");
		const observedMessages: Array<Record<string, unknown>> = [];
		const disconnectEvents: Array<string | undefined> = [];
		const adapter = new NodeSidecarSessionAdapter();
		const sessionHandle = adapter.openSession(socketPath, {
			onConnect() {
				return { ok: true, value: undefined };
			},
			onMessage(message) {
				observedMessages.push(message);
				return { ok: true, value: undefined };
			},
			onDisconnect(reason) {
				disconnectEvents.push(reason);
				return { ok: true, value: undefined };
			},
		});

		const firstSocket = net.createConnection(socketPath);
		await waitForSocketConnect(firstSocket);
		firstSocket.write('{"type":"partial"');
		firstSocket.end();
		await waitFor(() => disconnectEvents.length === 1);

		const secondSocket = net.createConnection(socketPath);
		await waitForSocketConnect(secondSocket);
		secondSocket.write(`${JSON.stringify({ type: "complete", seq: 1 })}\n`);
		await waitFor(() => observedMessages.length === 1);
		secondSocket.end();
		await waitFor(() => disconnectEvents.length === 2);

		expect(observedMessages).toEqual([{ type: "complete", seq: 1 }]);
		expect(disconnectEvents).toEqual([undefined, undefined]);
		sessionHandle.close();
	});

	it("resets disconnect reason state before accepting a reconnect on the same socket path", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnx-sock-reconnect-reason-"));
		const socketPath = path.join(runtimeDir, "sidecar.sock");
		const disconnectEvents: Array<string | undefined> = [];
		const adapter = new NodeSidecarSessionAdapter();
		const sessionHandle = adapter.openSession(socketPath, {
			onConnect() {
				return { ok: true, value: undefined };
			},
			onMessage() {
				return { ok: true, value: undefined };
			},
			onDisconnect(reason) {
				disconnectEvents.push(reason);
				return { ok: true, value: undefined };
			},
		});

		const firstSocket = net.createConnection(socketPath);
		await waitForSocketConnect(firstSocket);
		firstSocket.write("{not-json}\n");
		await waitFor(() => disconnectEvents.length === 1);
		expect(disconnectEvents[0]).toContain("invalid child message JSON");

		const secondSocket = net.createConnection(socketPath);
		await waitForSocketConnect(secondSocket);
		secondSocket.end();
		await waitFor(() => disconnectEvents.length === 2);

		expect(disconnectEvents[1]).toBeUndefined();
		sessionHandle.close();
	});

	it("rejects handshake identity mismatch and shuts the child down", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrap = makeBootstrap("agt_child_mismatch", runtimeDir, fakeExtensionPath);
		const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

		const socket = new FakeSocket();
		const pi = new FakePiApi();
		const ctx = new FakeExtensionContext();
		installSubagentBootstrapExtension(pi, {
			env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
			connectSocket: () => socket,
			now: () => "2026-03-12T10:02:00.000Z",
		});

		const sessionStart = pi.emit("session_start", {}, ctx);
		socket.connect();
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "hello",
			seq: 0,
			time: "2026-03-12T10:02:01.000Z",
			payload: {
				sessionPath: bootstrap.sessionPath,
				tmuxTarget: "other:window",
				mode: bootstrap.tmuxMode,
			},
		});

		await expect(sessionStart).rejects.toThrow("hello tmuxTarget must match bootstrap tmuxTarget");
		expect(ctx.shutdownCalls).toBe(1);
		expect(parseSentEnvelopes(socket)).toEqual([]);
	});

	it("does not advertise ready if bootstrap prompt injection fails", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrap = makeBootstrap("agt_child_prompt_failure", runtimeDir, fakeExtensionPath);
		const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

		const socket = new FakeSocket();
		const pi = new FakePiApi();
		(pi as unknown as { sendUserMessage: (content: string) => void }).sendUserMessage = () => {
			throw new Error("prompt injection failed");
		};
		const ctx = new FakeExtensionContext();
		installSubagentBootstrapExtension(pi, {
			env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
			connectSocket: () => socket,
			now: () => "2026-03-12T10:02:10.000Z",
		});

		const sessionStart = pi.emit("session_start", {}, ctx);
		socket.connect();
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "hello",
			seq: 0,
			time: "2026-03-12T10:02:11.000Z",
			payload: {
				sessionPath: bootstrap.sessionPath,
				tmuxTarget: bootstrap.tmuxTarget,
				mode: bootstrap.tmuxMode,
			},
		});

		await expect(sessionStart).rejects.toThrow("prompt injection failed");
		expect(ctx.shutdownCalls).toBe(1);
		expect(parseSentEnvelopes(socket)).toEqual([]);
	});

	it("does not advertise ready if bootstrap prompt injection is unavailable", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrap = makeBootstrap("agt_child_prompt_missing", runtimeDir, fakeExtensionPath);
		const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

		const socket = new FakeSocket();
		const pi = new FakePiApi();
		(pi as unknown as { sendUserMessage?: undefined }).sendUserMessage = undefined;
		const ctx = new FakeExtensionContext();
		installSubagentBootstrapExtension(pi, {
			env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
			connectSocket: () => socket,
			now: () => "2026-03-12T10:02:20.000Z",
		});

		const sessionStart = pi.emit("session_start", {}, ctx);
		socket.connect();
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "hello",
			seq: 0,
			time: "2026-03-12T10:02:21.000Z",
			payload: {
				sessionPath: bootstrap.sessionPath,
				tmuxTarget: bootstrap.tmuxTarget,
				mode: bootstrap.tmuxMode,
			},
		});

		await expect(sessionStart).rejects.toThrow("pi.sendUserMessage must be available for bootstrap prompt injection");
		expect(ctx.shutdownCalls).toBe(1);
		expect(parseSentEnvelopes(socket)).toEqual([]);
	});

	it("still settles startup rejection if teardown cleanup throws during a pre-ready failure", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrap = makeBootstrap("agt_child_cleanup_failure", runtimeDir, fakeExtensionPath);
		const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

		const socket = new FakeSocket({
			throwOnDestroy: new Error("destroy exploded"),
		});
		const pi = new FakePiApi();
		const ctx = new FakeExtensionContext({
			throwOnShutdown: new Error("shutdown exploded"),
		});
		installSubagentBootstrapExtension(pi, {
			env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
			connectSocket: () => socket,
			now: () => "2026-03-12T10:02:25.000Z",
			clearTimeoutFn: () => {
				throw new Error("clear timeout exploded");
			},
		});

		const sessionStart = pi.emit("session_start", {}, ctx);
		socket.connect();
		socket.receive({
			version: 1,
			agentId: bootstrap.agentId,
			type: "hello",
			seq: 0,
			time: "2026-03-12T10:02:26.000Z",
			payload: {
				sessionPath: bootstrap.sessionPath,
				tmuxTarget: "other:child",
				mode: bootstrap.tmuxMode,
			},
		});

		const error = await sessionStart.catch((rejection: unknown) => rejection);
		expect(error).toBeInstanceOf(AggregateError);
		expect((error as Error).message).toContain("hello tmuxTarget must match bootstrap tmuxTarget");
		const cleanupMessages = (error as AggregateError).errors.map((entry) => normalizeError(entry).message);
		expect(cleanupMessages).toEqual([
			"clear timeout exploded",
			"destroy exploded",
			"shutdown exploded",
		]);
		expect(socket.destroyed).toBe(true);
		expect(ctx.shutdownCalls).toBe(1);
		expect(parseSentEnvelopes(socket)).toEqual([]);
	});

	it("fails the startup if the parent never completes hello before timeout", async () => {
		vi.useFakeTimers();
		try {
			const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
			const bootstrap = makeBootstrap("agt_child_timeout", runtimeDir, fakeExtensionPath);
			const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
			fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);

			const socket = new FakeSocket();
			const pi = new FakePiApi();
			const ctx = new FakeExtensionContext();
			installSubagentBootstrapExtension(pi, {
				env: { [BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath },
				connectSocket: () => socket,
				handshakeTimeoutMs: 25,
			});

			const sessionStart = pi.emit("session_start", {}, ctx);
			const rejection = sessionStart.catch((error: unknown) => normalizeError(error));
			socket.connect();
			await vi.advanceTimersByTimeAsync(30);

			const error = await rejection;
			expect(error.message).toContain("child did not receive hello before timeout");
			expect(ctx.shutdownCalls).toBe(1);
			expect(socket.destroyed).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

function normalizeError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	return new Error(String(error));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}

	throw new Error("timed out waiting for condition");
}

async function waitForSocketConnect(socket: net.Socket): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
}
