import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { __testing, createTmuxCommandRunner, installParentExtension } from "../src/parent-extension.js";
import type {
	RuntimeLaunchSpec,
	SidecarControlMessage,
	SubagentUiSnapshot,
	ValidationOutcome,
} from "../src/contracts.js";
import type {
	ManagedProcessExit,
	SidecarSessionAdapter,
	SidecarSessionHandle,
	SidecarSessionHandlers,
	SubagentProcessAdapter,
	SubagentProcessHandle,
} from "../src/subagent-manager.js";

type ExtensionHandler = (event: unknown, ctx: FakeExtensionContext) => unknown | Promise<unknown>;

class FakeExtensionContext {
	public hasUI = true;
	public idle = true;
	public readonly notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	public readonly widgetUpdates: Array<{
		key: string;
		content: string[] | undefined;
		options?: Record<string, unknown>;
	}> = [];
	public readonly customCalls: Array<{
		options?: Record<string, unknown>;
	}> = [];

	public constructor(
		public cwd: string,
		private readonly sessionFile: string,
	) {}

	public readonly sessionManager = {
		getSessionFile: () => this.sessionFile,
		getEntries: () => [],
	};

	public readonly ui = {
		notify: (message: string, type?: "info" | "warning" | "error") => {
			this.notifications.push({ message, type });
		},
		setWidget: (
			key: string,
			content: string[] | undefined,
			options?: Record<string, unknown>,
		) => {
			this.widgetUpdates.push({ key, content, options });
		},
		custom: async (
			_factory: unknown,
			options?: Record<string, unknown>,
		) => {
			this.customCalls.push({ options });
			return undefined;
		},
	};

	public isIdle(): boolean {
		return this.idle;
	}

	public async waitForIdle(): Promise<void> {}
}

class FakePiApi {
	public readonly handlers = new Map<string, ExtensionHandler[]>();
	public readonly tools: Array<Record<string, unknown>> = [];
	public readonly commands = new Map<string, Record<string, unknown>>();
	public readonly messageRenderers = new Map<string, unknown>();
	public readonly appendedEntries: Array<{ customType: string; data?: unknown }> = [];
	public readonly sentMessages: Array<{
		message: Record<string, unknown>;
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
	}> = [];
	public readonly sentUserMessages: Array<{
		content: string | Array<{ type: "text"; text: string }>;
		options?: { deliverAs?: "steer" | "followUp" };
	}> = [];

	public on(event: string, handler: ExtensionHandler): void {
		const existing = this.handlers.get(event) ?? [];
		existing.push(handler);
		this.handlers.set(event, existing);
	}

	public registerTool(definition: Record<string, unknown>): void {
		this.tools.push(definition);
	}

	public registerCommand(name: string, definition: Record<string, unknown>): void {
		this.commands.set(name, definition);
	}

	public registerMessageRenderer(customType: string, renderer: unknown): void {
		this.messageRenderers.set(customType, renderer);
	}

	public appendEntry(customType: string, data?: unknown): void {
		this.appendedEntries.push({ customType, data });
	}

	public sendMessage(
		message: Record<string, unknown>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void {
		this.sentMessages.push({ message, options });
	}

	public sendUserMessage(
		content: string | Array<{ type: "text"; text: string }>,
		options?: { deliverAs?: "steer" | "followUp" },
	): void {
		this.sentUserMessages.push({ content, options });
	}

	public async emit(event: string, payload: unknown, ctx: FakeExtensionContext): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}
}

class FakeSidecarSession implements SidecarSessionHandle {
	public readonly sent: SidecarControlMessage[] = [];
	public closeCount = 0;

	public constructor(private readonly handlers: SidecarSessionHandlers) {}

	public send(message: SidecarControlMessage): void {
		this.sent.push(message);
	}

	public close(): void {
		this.closeCount += 1;
	}

	public connect(): ValidationOutcome<unknown> {
		return this.handlers.onConnect();
	}

	public message(message: unknown): ValidationOutcome<unknown> {
		return this.handlers.onMessage(message);
	}
}

class FakeSidecarSessions implements SidecarSessionAdapter {
	public readonly sessions = new Map<string, FakeSidecarSession>();

	public openSession(socketPath: string, handlers: SidecarSessionHandlers): SidecarSessionHandle {
		const agentId = path.basename(path.dirname(socketPath));
		const session = new FakeSidecarSession(handlers);
		this.sessions.set(agentId, session);
		return session;
	}

	public get(agentId: string): FakeSidecarSession {
		const session = this.sessions.get(agentId);
		if (!session) {
			throw new Error(`missing sidecar session for ${agentId}`);
		}

		return session;
	}
}

class FakeProcessHandle implements SubagentProcessHandle {
	public readonly terminateReasons: Array<"interrupt" | "shutdown"> = [];

	public constructor(
		public readonly launchSpec: RuntimeLaunchSpec,
		private readonly exitHandler: (exit: ManagedProcessExit) => ValidationOutcome<unknown>,
	) {}

	public terminate(reason: "interrupt" | "shutdown"): void {
		this.terminateReasons.push(reason);
	}

	public exit(exit: ManagedProcessExit): ValidationOutcome<unknown> {
		return this.exitHandler(exit);
	}
}

class FakeProcesses implements SubagentProcessAdapter {
	public readonly handles = new Map<string, FakeProcessHandle>();

	public launch(
		launchSpec: RuntimeLaunchSpec,
		handlers: { onExit: (exit: ManagedProcessExit) => ValidationOutcome<unknown> },
	): SubagentProcessHandle {
		const handle = new FakeProcessHandle(launchSpec, handlers.onExit);
		this.handles.set(launchSpec.agentId, handle);
		return handle;
	}

	public get(agentId: string): FakeProcessHandle {
		const handle = this.handles.get(agentId);
		if (!handle) {
			throw new Error(`missing process handle for ${agentId}`);
		}

		return handle;
	}
}

class FakeTmuxRuntime {
	public readonly killedSessions: string[] = [];
	public readonly sessionTargets = new Map<string, { windowTarget: string; paneTarget: string }>();

	public run(args: string[]): ValidationOutcome<string> {
		const [command, ...rest] = args;
		switch (command) {
			case "new-session": {
				const sessionName = rest[rest.indexOf("-s") + 1];
				const windowName = rest[rest.indexOf("-n") + 1];
				if (!sessionName || !windowName) {
					return { ok: false, error: "malformed new-session command" };
				}
				this.sessionTargets.set(sessionName, {
					windowTarget: `${sessionName}:${windowName}`,
					paneTarget: `${sessionName}:${windowName}.0`,
				});
				return { ok: true, value: "" };
			}
			case "list-panes": {
				const windowTarget = rest[rest.indexOf("-t") + 1];
				if (!windowTarget) {
					return { ok: false, error: "missing pane target" };
				}
				const sessionName = windowTarget.slice(0, windowTarget.indexOf(":"));
				const runtime = this.sessionTargets.get(sessionName);
				if (!runtime) {
					return { ok: false, error: `unknown tmux session: ${sessionName}` };
				}
				return { ok: true, value: runtime.paneTarget };
			}
			case "kill-session": {
				const sessionName = rest[rest.indexOf("-t") + 1];
				if (!sessionName) {
					return { ok: false, error: "missing session name" };
				}
				this.killedSessions.push(sessionName);
				this.sessionTargets.delete(sessionName);
				return { ok: true, value: "" };
			}
			default:
				return { ok: false, error: `unexpected tmux command: ${args.join(" ")}` };
		}
	}
}

function makeEnvelope(
	agentId: string,
	type: string,
	seq: number,
	time: string,
	payload: Record<string, unknown>,
): Record<string, unknown> {
	return {
		version: 1,
		agentId,
		type,
		seq,
		time,
		payload,
	};
}

function getRegisteredTool(pi: FakePiApi, name: string): {
	execute: (...args: unknown[]) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
} {
	const tool = pi.tools.find((entry) => entry.name === name);
	if (!tool) {
		throw new Error(`missing tool ${name}`);
	}

	return tool as {
		execute: (...args: unknown[]) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
	};
}

function getRegisteredCommand(pi: FakePiApi, name: string): {
	handler: (args: string, ctx: FakeExtensionContext) => Promise<void>;
} {
	const command = pi.commands.get(name);
	if (!command) {
		throw new Error(`missing command ${name}`);
	}

	return command as {
		handler: (args: string, ctx: FakeExtensionContext) => Promise<void>;
	};
}

function getMessageRenderer(
	pi: FakePiApi,
	customType: string,
): (
	message: { customType: string; content: string; details?: unknown },
	options: { expanded?: boolean },
	theme: unknown,
) => { render(width: number): string[] } | undefined {
	const renderer = pi.messageRenderers.get(customType);
	if (!renderer) {
		throw new Error(`missing renderer ${customType}`);
	}
	return renderer as (
		message: { customType: string; content: string; details?: unknown },
		options: { expanded?: boolean },
		theme: unknown,
	) => { render(width: number): string[] } | undefined;
}

function makeUiSnapshot(overrides: Partial<SubagentUiSnapshot> = {}): SubagentUiSnapshot {
	return {
		agentId: "agt_test",
		displayName: "Researcher",
		type: "Researcher",
		description: "Review the current repo state",
		state: "running",
		availability: "live",
		tmuxMode: "window",
		tmuxTarget: "pnx_test:child",
		sessionPath: "/tmp/agt_test/session.jsonl",
		startedAt: "2026-03-13T12:00:00.000Z",
		endedAt: undefined,
		latestSummary: undefined,
		pendingInputQuestion: undefined,
		finalSummary: undefined,
		errorMessage: undefined,
		note: undefined,
		isStale: false,
		isDegraded: false,
		isHistorical: false,
		canOpenPeek: true,
		canOpenFollow: true,
		canOpenTakeOver: true,
		canSend: true,
		canInterrupt: true,
		...overrides,
	};
}

let originalPath: string | undefined;
let fakeBinDir = os.tmpdir();
let fakeHomeDir = os.tmpdir();
let fakeRepoDir = os.tmpdir();
let fakeBootstrapExtensionPath = path.join(os.tmpdir(), "bootstrap-extension.ts");

beforeAll(() => {
	originalPath = process.env.PATH;
	fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-parent-ext-bin-"));
	fakeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-parent-ext-home-"));
	fakeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-parent-ext-repo-"));
	fakeBootstrapExtensionPath = path.join(fakeRepoDir, "bootstrap-extension.ts");

	fs.writeFileSync(path.join(fakeBinDir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	fs.writeFileSync(fakeBootstrapExtensionPath, "export {};\n", "utf8");

	process.env.PATH = [fakeBinDir, originalPath].filter((value): value is string => typeof value === "string").join(path.delimiter);
});

afterAll(() => {
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}

	fs.rmSync(fakeBinDir, { recursive: true, force: true });
	fs.rmSync(fakeHomeDir, { recursive: true, force: true });
	fs.rmSync(fakeRepoDir, { recursive: true, force: true });
});

afterEach(() => {
	vi.restoreAllMocks();
});

beforeEach(() => {
	fs.rmSync(path.join(fakeRepoDir, ".pi"), { recursive: true, force: true });
});

describe("installParentExtension", () => {
	it("spawns named subagents and exposes /subagents list and open output", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:00:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const customAgentDir = path.join(fakeRepoDir, ".pi", "agents");
		fs.mkdirSync(customAgentDir, { recursive: true });
		fs.writeFileSync(
			path.join(customAgentDir, "Researcher.md"),
			`---
description: Research specialist
display_name: Researcher
---

Research the codebase carefully and report findings.`,
			"utf8",
		);

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "main.jsonl"));
		await pi.emit("session_start", {}, ctx);

		const tool = getRegisteredTool(pi, "Subagent");
		const result = await tool.execute(
			"tool-call-1",
			{
				action: "spawn",
				prompt: "Inspect the repository and summarize the architecture.",
				description: "Architecture review",
				subagent_type: "Researcher",
			},
			undefined,
			undefined,
			ctx,
		);

		const output = result.content[0]?.text ?? "";
		expect(output).toContain("Spawned subagent agt_001_");
		expect(output).toContain("Type: Researcher (Researcher)");
		expect(output).toContain("Use /subagents or Alt+A to open the subagent browser");
		expect(ctx.widgetUpdates.at(-1)?.options).toMatchObject({ placement: "aboveEditor" });
		expect(ctx.widgetUpdates.at(-1)?.content).toEqual(expect.arrayContaining([
			"Subagents  live=1 history=0",
			expect.stringMatching(/^  agt_001_.*state=connecting elapsed=0s$/),
		]));

		const agentId = Array.from(processes.handles.keys())[0];
		expect(agentId).toMatch(/^agt_001_/);
		const launchSpec = processes.get(agentId).launchSpec;
		expect(launchSpec.initialPrompt).toContain("Research the codebase carefully");
		expect(launchSpec.tmuxTarget).toBe(`${tmux.killedSessions[0] ?? Array.from(tmux.sessionTargets.keys())[0]}:child`);

		const command = getRegisteredCommand(pi, "subagents");
		await command.handler("list", ctx);
		const listContent = String(pi.sentMessages.at(-1)?.message.content ?? "");
		expect(listContent).toContain("Subagents · live=1 · history=0");
		expect(listContent).toContain(agentId);
		expect(listContent).toContain("Researcher");
		expect(listContent).toContain("state=connecting");

		await command.handler(`open ${agentId} follow`, ctx);
		expect(ctx.customCalls).toHaveLength(1);
		expect(ctx.customCalls[0]?.options).toMatchObject({
			screen: true,
		});
		expect(ctx.notifications.at(-1)?.message).toContain(`Opened ${agentId} in Follow.`);
		expect(pi.appendedEntries.at(-1)?.customType).toBe("pi-nexus-ui-state");

		expect(sidecars.get(agentId).connect()).toEqual({ ok: true, value: expect.anything() });
		expect(sidecars.get(agentId).message(
			makeEnvelope(agentId, "ready", 0, "2026-03-13T12:00:01.000Z", {
				pid: 101,
				sessionPath: launchSpec.sessionPath,
				tmuxTarget: launchSpec.tmuxTarget,
			}),
		)).toEqual({ ok: true, value: expect.anything() });

		await command.handler(`send ${agentId} keep going`, ctx);
		const sendContent = String(pi.sentMessages.at(-1)?.message.content ?? "");
		expect(sendContent).toContain(`Queued follow-up for ${agentId}.`);
		expect(sendContent).toContain("Researcher");
		expect(sendContent).toContain("Message");
		expect(sendContent).toContain("keep going");
		expect(sidecars.get(agentId).sent.at(-1)).toMatchObject({
			type: "follow_up",
			payload: { message: "keep going" },
		});
	});

	it("accepts slash-command args that include the command name", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:02:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const customAgentDir = path.join(fakeRepoDir, ".pi", "agents");
		fs.mkdirSync(customAgentDir, { recursive: true });
		fs.writeFileSync(
			path.join(customAgentDir, "Researcher.md"),
			`---
description: Research specialist
display_name: Researcher
---

Research the codebase carefully and report findings.`,
			"utf8",
		);

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "slash-command-shape.jsonl"));
		await pi.emit("session_start", {}, ctx);

		const tool = getRegisteredTool(pi, "Subagent");
		const result = await tool.execute(
			"tool-call-1",
			{
				action: "spawn",
				prompt: "Report progress once and wait.",
				description: "Slash command shape",
				subagent_type: "Researcher",
			},
			undefined,
			undefined,
			ctx,
		);

		const agentId = Array.from(processes.handles.keys())[0];
		expect(agentId).toMatch(/^agt_001_/);
		expect(result.content[0]?.text ?? "").toContain(agentId);
		const command = getRegisteredCommand(pi, "subagents");

		await command.handler("subagents list", ctx);
		expect(String(pi.sentMessages.at(-1)?.message.content ?? "")).toContain(agentId);

		await command.handler(`subagents open ${agentId} follow`, ctx);
		expect(ctx.customCalls).toHaveLength(1);
		expect(ctx.notifications.at(-1)?.message).toContain(`Opened ${agentId} in Follow.`);
		expect(pi.sentMessages.at(-1)?.message.customType).toBe("pi-nexus-subagent-open");
		expect(String(pi.sentMessages.at(-1)?.message.content ?? "")).toContain("Mode: follow");
	});

	it("manages live children through the generic Subagent tool", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:05:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "subagent-tool.jsonl"));
		await pi.emit("session_start", {}, ctx);

		const tool = getRegisteredTool(pi, "Subagent");
		const spawnResult = await tool.execute(
			"tool-call-subagent-spawn",
			{
				action: "spawn",
				prompt: "Say hi and wait for the next instruction.",
				description: "Greeting child",
				subagent_type: "general-purpose",
			},
			undefined,
			undefined,
			ctx,
		);

		const spawnText = spawnResult.content[0]?.text ?? "";
		expect(spawnText).toContain("Spawned subagent agt_001_");
		expect(spawnText).toContain("Use the Subagent tool with action=open, send, or interrupt");

		const agentId = Array.from(processes.handles.keys())[0];
		const launchSpec = processes.get(agentId).launchSpec;
		expect(sidecars.get(agentId).connect()).toEqual({ ok: true, value: expect.anything() });
		expect(sidecars.get(agentId).message(
			makeEnvelope(agentId, "ready", 0, "2026-03-13T12:05:01.000Z", {
				pid: 303,
				sessionPath: launchSpec.sessionPath,
				tmuxTarget: launchSpec.tmuxTarget,
			}),
		)).toEqual({ ok: true, value: expect.anything() });

		const listResult = await tool.execute(
			"tool-call-subagent-list",
			{ action: "list" },
			undefined,
			undefined,
			ctx,
		);
		expect(listResult.content[0]?.text ?? "").toContain("Subagents · live=1 · history=0");
		expect(listResult.content[0]?.text ?? "").toContain(agentId);

		const openResult = await tool.execute(
			"tool-call-subagent-open",
			{ action: "open", agent_id: agentId, mode: "take_over" },
			undefined,
			undefined,
			ctx,
		);
		expect(openResult.content[0]?.text ?? "").toContain(`Entered Take Over for ${agentId}.`);
		expect(ctx.customCalls).toHaveLength(1);

		const followOpenResult = await tool.execute(
			"tool-call-subagent-open-follow",
			{ action: "open", agent_id: agentId, mode: "follow" },
			undefined,
			undefined,
			ctx,
		);
		expect(followOpenResult.content[0]?.text ?? "").toContain(`Opened ${agentId} in Follow.`);
		expect(followOpenResult.content[0]?.text ?? "").toContain("Mode: follow");
		expect(followOpenResult.content[0]?.text ?? "").toContain("Agent");
		expect(followOpenResult.content[0]?.text ?? "").toContain("availability=live");

		const sendResult = await tool.execute(
			"tool-call-subagent-send",
			{ action: "send", agent_id: agentId, message: "send joke 2" },
			undefined,
			undefined,
			ctx,
		);
		expect(sendResult.content[0]?.text ?? "").toContain(`Queued follow-up for ${agentId}.`);
		expect(sendResult.content[0]?.text ?? "").toContain("Agent");
		expect(sendResult.content[0]?.text ?? "").toContain("Message");
		expect(sendResult.content[0]?.text ?? "").toContain("send joke 2");
		expect(sidecars.get(agentId).sent.at(-1)).toMatchObject({
			type: "follow_up",
			payload: { message: "send joke 2" },
		});

		const interruptResult = await tool.execute(
			"tool-call-subagent-interrupt",
			{ action: "interrupt", agent_id: agentId },
			undefined,
			undefined,
			ctx,
		);
		expect(interruptResult.content[0]?.text ?? "").toContain(`Sent interrupt to ${agentId}.`);
		expect(interruptResult.content[0]?.text ?? "").toContain("The parent requested the child to stop current work.");
		expect(sidecars.get(agentId).sent.at(-1)).toMatchObject({
			type: "interrupt",
			payload: {},
		});
	});

	it("fails legacy focus paths with a migration message", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:06:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "legacy-focus.jsonl"));
		await pi.emit("session_start", {}, ctx);

		const tool = getRegisteredTool(pi, "Subagent");
		const toolResult = await tool.execute(
			"tool-call-subagent-focus-legacy",
			{ action: "focus", agent_id: "agt_legacy" },
			undefined,
			undefined,
			ctx,
		);
		expect(toolResult.content[0]?.text ?? "").toContain("action=focus has been removed");
		expect(toolResult.content[0]?.text ?? "").toContain("action=open");

		const command = getRegisteredCommand(pi, "subagents");
		await command.handler("focus agt_legacy", ctx);
		expect(String(pi.sentMessages.at(-1)?.message.content ?? "")).toContain("/subagents open");
	});

	it("bridges accepted child progress and final_result back into the parent session", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:10:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "bridge.jsonl"));
		await pi.emit("session_start", {}, ctx);
		ctx.idle = false;
		await pi.emit("agent_start", {}, ctx);

		const tool = getRegisteredTool(pi, "Subagent");
		await tool.execute(
			"tool-call-bridge",
			{
				action: "spawn",
				prompt: "Do the work.",
				description: "Bridge test",
				subagent_type: "Explore",
			},
			undefined,
			undefined,
			ctx,
		);

		const agentId = Array.from(processes.handles.keys())[0];
		const sidecar = sidecars.get(agentId);
		expect(sidecar.connect()).toEqual({ ok: true, value: expect.anything() });
		expect(sidecar.message(
			makeEnvelope(agentId, "ready", 0, "2026-03-13T12:10:01.000Z", {
				pid: 101,
				sessionPath: processes.get(agentId).launchSpec.sessionPath,
				tmuxTarget: processes.get(agentId).launchSpec.tmuxTarget,
			}),
		)).toEqual({ ok: true, value: expect.anything() });
		expect(sidecar.message(
			makeEnvelope(agentId, "progress", 1, "2026-03-13T12:10:02.000Z", {
				summary: "Working on the task",
				data: { step: 1 },
			}),
		)).toEqual({ ok: true, value: expect.anything() });
		expect(sidecar.message(
			makeEnvelope(agentId, "final_result", 2, "2026-03-13T12:10:03.000Z", {
				summary: "Completed the task",
				data: { status: "done" },
			}),
		)).toEqual({ ok: true, value: expect.anything() });

		const progressMessage = pi.sentMessages.find((entry) => entry.message.customType === "pi-nexus-subagent-progress");
		expect(progressMessage?.message.content).toContain("Working on the task");
		expect(progressMessage?.message.details).toMatchObject({
			agentId,
			state: "running",
		});
		expect(pi.sentUserMessages.at(-1)).toEqual({
			content: expect.stringContaining("Subagent final_result"),
			options: { deliverAs: "followUp" },
		});
		expect(String(pi.sentUserMessages.at(-1)?.content)).toContain("Completed the task");
	});

	it("registers and renders custom subagent message types", () => {
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
		});

		expect(Array.from(pi.messageRenderers.keys()).sort()).toEqual([
			"pi-nexus-subagent-open",
			"pi-nexus-subagent-progress",
			"pi-nexus-subagent-status",
			"pi-nexus-subagents-output",
		]);

		const progressRenderer = getMessageRenderer(pi, "pi-nexus-subagent-progress");
		const renderedProgress = progressRenderer(
			{
				customType: "pi-nexus-subagent-progress",
				content: "Summary line\nMore detail",
				details: { agentId: "agt_render", state: "running" },
			},
			{},
			{},
		);
		expect(renderedProgress?.render(80)).toEqual([
			"Subagent progress · agt_render · running",
			"Summary line",
			"More detail",
		]);

		const statusRenderer = getMessageRenderer(pi, "pi-nexus-subagent-status");
		const renderedStatus = statusRenderer(
			{
				customType: "pi-nexus-subagent-status",
				content: "Subagent assumptions are stale for agt_render after direct tmux intervention.",
				details: { agentId: "agt_render" },
			},
			{},
			{},
		);
		expect(renderedStatus?.render(80)).toEqual([
			"Subagent status · agt_render",
			"Subagent assumptions are stale for agt_render after direct tmux intervention.",
		]);

		const openRenderer = getMessageRenderer(pi, "pi-nexus-subagent-open");
		const renderedOpen = openRenderer(
			{
				customType: "pi-nexus-subagent-open",
				content: "Opened agt_render in Follow.\nAgent · agt_render\nstate=running · availability=live\n\nMode: follow",
				details: { agentId: "agt_render", mode: "follow" },
			},
			{},
			{},
		);
		expect(renderedOpen?.render(26)).toEqual(expect.arrayContaining([
			expect.stringContaining("Subagent open"),
			"Agent · agt_render",
			"state=running ·",
			"availability=live",
			"",
			"Mode: follow",
		]));

		const outputRenderer = getMessageRenderer(pi, "pi-nexus-subagents-output");
		const renderedOutput = outputRenderer(
			{
				customType: "pi-nexus-subagents-output",
				content: "Queued follow-up for agt_render.\nMessage\nkeep going",
				details: { command: "send" },
			},
			{},
			{},
		);
		expect(renderedOutput?.render(80)).toEqual([
			"Subagents · send",
			"Queued follow-up for agt_render.",
			"Message",
			"keep going",
		]);
	});

	it("bridges needs_input and error events with structured follow-up copy", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:11:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "bridge-needs-input.jsonl"));
		await pi.emit("session_start", {}, ctx);

		const tool = getRegisteredTool(pi, "Subagent");
		await tool.execute(
			"tool-call-bridge-needs-input",
			{
				action: "spawn",
				prompt: "Ask for help if blocked.",
				description: "Needs input test",
				subagent_type: "general-purpose",
			},
			undefined,
			undefined,
			ctx,
		);

		const agentId = Array.from(processes.handles.keys())[0];
		const sidecar = sidecars.get(agentId);
		expect(sidecar.connect()).toEqual({ ok: true, value: expect.anything() });
		expect(sidecar.message(
			makeEnvelope(agentId, "ready", 0, "2026-03-13T12:11:01.000Z", {
				pid: 102,
				sessionPath: processes.get(agentId).launchSpec.sessionPath,
				tmuxTarget: processes.get(agentId).launchSpec.tmuxTarget,
			}),
		)).toEqual({ ok: true, value: expect.anything() });
		expect(sidecar.message(
			makeEnvelope(agentId, "needs_input", 1, "2026-03-13T12:11:02.000Z", {
				question: "Which API should I call?",
				kind: "decision",
				data: null,
			}),
		)).toEqual({ ok: true, value: expect.anything() });
		expect(String(pi.sentUserMessages.at(-1)?.content)).toContain("Subagent needs_input");
		expect(String(pi.sentUserMessages.at(-1)?.content)).toContain("Question: Which API should I call?");

		expect(sidecar.message(
			makeEnvelope(agentId, "error", 2, "2026-03-13T12:11:03.000Z", {
				fatal: false,
				message: "Lost connection to helper",
			}),
		)).toEqual({ ok: true, value: expect.anything() });
		expect(String(pi.sentUserMessages.at(-1)?.content)).toContain("Subagent error");
		expect(String(pi.sentUserMessages.at(-1)?.content)).toContain("Message: Lost connection to helper");
		expect(String(pi.sentUserMessages.at(-1)?.content)).toContain("Fatal: no");
	});

	it("refreshes live widget elapsed time between child events", async () => {
		vi.useFakeTimers();
		try {
			let currentTimeMs = Date.parse("2026-03-13T12:15:00.000Z");
			const sidecars = new FakeSidecarSessions();
			const processes = new FakeProcesses();
			const tmux = new FakeTmuxRuntime();
			const pi = new FakePiApi();
			installParentExtension(pi, {
				bootstrapExtensionPath: fakeBootstrapExtensionPath,
				homeDir: fakeHomeDir,
				now: () => new Date(currentTimeMs).toISOString(),
				runTmuxCommand: (args) => tmux.run(args),
				sidecarSessions: sidecars,
				runtimeProcesses: processes,
			});

			const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "elapsed.jsonl"));
			await pi.emit("session_start", {}, ctx);

			const tool = getRegisteredTool(pi, "Subagent");
			await tool.execute(
				"tool-call-elapsed",
				{
					action: "spawn",
					prompt: "Keep working.",
					description: "Elapsed widget",
					subagent_type: "general-purpose",
				},
				undefined,
				undefined,
				ctx,
			);

			expect(ctx.widgetUpdates.at(-1)?.content).toEqual(expect.arrayContaining([
				expect.stringMatching(/^  agt_001_.*elapsed=0s$/),
			]));

			currentTimeMs += 6_000;
			await vi.advanceTimersByTimeAsync(6_000);

			expect(ctx.widgetUpdates.at(-1)?.content).toEqual(expect.arrayContaining([
				expect.stringMatching(/^  agt_001_.*elapsed=5s$/),
			]));
		} finally {
			vi.useRealTimers();
		}
	});

	it("prioritizes widget error summaries over older progress text", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:18:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "widget-error.jsonl"));
		await pi.emit("session_start", {}, ctx);

		const tool = getRegisteredTool(pi, "Subagent");
		await tool.execute(
			"tool-call-widget-error",
			{
				action: "spawn",
				prompt: "Do the work.",
				description: "Widget error",
				subagent_type: "general-purpose",
			},
			undefined,
			undefined,
			ctx,
		);

		const agentId = Array.from(processes.handles.keys())[0];
		const sidecar = sidecars.get(agentId);
		expect(sidecar.connect()).toEqual({ ok: true, value: expect.anything() });
		expect(sidecar.message(
			makeEnvelope(agentId, "ready", 0, "2026-03-13T12:18:01.000Z", {
				pid: 505,
				sessionPath: processes.get(agentId).launchSpec.sessionPath,
				tmuxTarget: processes.get(agentId).launchSpec.tmuxTarget,
			}),
		)).toEqual({ ok: true, value: expect.anything() });
		expect(sidecar.message(
			makeEnvelope(agentId, "progress", 1, "2026-03-13T12:18:02.000Z", {
				summary: "Almost there",
				data: null,
			}),
		)).toEqual({ ok: true, value: expect.anything() });
		expect(sidecar.message(
			makeEnvelope(agentId, "error", 2, "2026-03-13T12:18:03.000Z", {
				fatal: true,
				message: "Lost the child process",
			}),
		)).toEqual({ ok: true, value: expect.anything() });

		expect(ctx.widgetUpdates.at(-1)?.content).toEqual(expect.arrayContaining([
			"    error: Lost the child process",
		]));
		expect(ctx.widgetUpdates.at(-1)?.content).not.toEqual(expect.arrayContaining([
			"    latest: Almost there",
		]));
	});

	it("renders historical browser rows with history and degraded badges", () => {
		const lines = __testing.renderBrowserLines([
			makeUiSnapshot({
				agentId: "agt_live",
				displayName: "Live child",
				latestSummary: "Streaming output",
			}),
			makeUiSnapshot({
				agentId: "agt_hist",
				displayName: "Historical child",
				state: "failed",
				availability: "history",
				isHistorical: true,
				isDegraded: true,
				errorMessage: "socket closed before completion",
				endedAt: "2026-03-13T12:01:30.000Z",
				canOpenFollow: false,
				canOpenTakeOver: false,
				canSend: false,
				canInterrupt: false,
			}),
		], 1, 120, "2026-03-13T12:02:00.000Z");

		expect(lines).toEqual(expect.arrayContaining([
			"History (1)",
			expect.stringContaining("> Historical child · agt_hist"),
			expect.stringContaining("state=failed · history, degraded, error · 1m 30s"),
			expect.stringContaining("socket closed before completion"),
		]));
	});

	it("renders workspace summary lines with description, elapsed time, and error priority", () => {
		const lines = __testing.buildSnapshotSummaryLines(
			makeUiSnapshot({
				displayName: "Planner",
				agentId: "agt_summary",
				availability: "history",
				errorMessage: "Lost tmux pane",
				latestSummary: "Still working",
				finalSummary: "Would have been done",
				isHistorical: true,
				endedAt: "2026-03-13T12:01:15.000Z",
				canOpenFollow: false,
				canOpenTakeOver: false,
				canSend: false,
				canInterrupt: false,
			}),
			80,
		);

		expect(lines).toEqual(expect.arrayContaining([
			"Planner · agt_summary",
			expect.stringContaining("badges=history, error"),
			expect.stringContaining("Description: Review the current repo state"),
			expect.stringContaining("Elapsed: 1m 15s"),
			"Error",
			expect.stringContaining("Lost tmux pane"),
			"Latest",
			expect.stringContaining("Still working"),
			"Final",
			expect.stringContaining("Would have been done"),
		]));
		expect(lines.indexOf("Error")).toBeLessThan(lines.indexOf("Latest"));
	});

	it("renders workspace follow output with the acceptance header and live terminal framing", () => {
		const lines = __testing.renderWorkspaceLines(
			makeUiSnapshot({
				agentId: "agt_follow",
				displayName: "General",
				latestSummary: "RAT133 child started",
			}),
			"follow",
			["child line 1", "child line 2"],
			0,
			undefined,
			100,
			"2026-03-13T12:00:30.000Z",
		);

		expect(lines).toEqual(expect.arrayContaining([
			expect.stringContaining("Subagent agt_follow"),
			expect.stringContaining("Mode: follow"),
			expect.stringContaining("Live child terminal"),
			expect.stringContaining("Follow is read-only in phase 1."),
			expect.stringContaining("RAT133 child started"),
		]));
	});

	it("fails cleanly when tmux cannot execute and spawnSync omits stdout and stderr", async () => {
		const runTmuxCommand = createTmuxCommandRunner(() => {
			return {
				pid: 0,
				output: [null, undefined, undefined],
				stdout: undefined,
				stderr: undefined,
				status: null,
				signal: "SIGTERM",
				error: new Error("spawn tmux ENOENT"),
			} as unknown as ReturnType<typeof childProcess.spawnSync>;
		});

		expect(runTmuxCommand(["new-session", "-d", "-s", "missing", "-n", "child"])).toEqual({
			ok: false,
			error: "tmux new-session -d -s missing -n child failed: spawn tmux ENOENT",
		});
	});

	it("keeps assumptions stale after direct intervention until the next explicit child report", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:20:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "stale.jsonl"));
		await pi.emit("session_start", {}, ctx);

		const tool = getRegisteredTool(pi, "Subagent");
		await tool.execute(
			"tool-call-stale",
			{
				action: "spawn",
				prompt: "Wait for input.",
				description: "Stale handling",
				subagent_type: "Plan",
				tmux_mode: "pane",
			},
			undefined,
			undefined,
			ctx,
		);

		const agentId = Array.from(processes.handles.keys())[0];
		const sidecar = sidecars.get(agentId);
		expect(sidecar.connect()).toEqual({ ok: true, value: expect.anything() });
		expect(sidecar.message(
			makeEnvelope(agentId, "ready", 0, "2026-03-13T12:20:01.000Z", {
				pid: 202,
				sessionPath: processes.get(agentId).launchSpec.sessionPath,
				tmuxTarget: processes.get(agentId).launchSpec.tmuxTarget,
			}),
		)).toEqual({ ok: true, value: expect.anything() });
		expect(sidecar.message(
			makeEnvelope(agentId, "progress", 1, "2026-03-13T12:20:02.000Z", {
				summary: "Thinking",
				data: null,
			}),
		)).toEqual({ ok: true, value: expect.anything() });
		const sentUserMessageCountBeforeIntervention = pi.sentUserMessages.length;
		expect(sidecar.message(
			makeEnvelope(agentId, "user_intervened", 2, "2026-03-13T12:20:03.000Z", {
				source: "tmux",
				mode: "direct-chat",
			}),
		)).toEqual({ ok: true, value: expect.anything() });

		const listCommand = getRegisteredCommand(pi, "subagents");
		await listCommand.handler("list", ctx);
		const staleListContent = String(pi.sentMessages.at(-1)?.message.content ?? "");
		expect(staleListContent).toContain("badges=stale");
		expect(pi.sentUserMessages).toHaveLength(sentUserMessageCountBeforeIntervention);
		expect(String(pi.sentMessages.at(-2)?.message.content ?? "")).toContain("assumptions are stale");

		expect(sidecar.message(
			makeEnvelope(agentId, "progress", 3, "2026-03-13T12:20:04.000Z", {
				summary: "Fresh progress",
				data: null,
			}),
		)).toEqual({ ok: true, value: expect.anything() });

		await listCommand.handler("list", ctx);
		const refreshedListContent = String(pi.sentMessages.at(-1)?.message.content ?? "");
		expect(refreshedListContent).not.toContain("badges=stale");
	});

	it("kills the allocated tmux session when agent runtime directory setup fails", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:25:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const fixedNow = 1_762_345_678_900;
		vi.spyOn(Date, "now").mockReturnValue(fixedNow);

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "mkdir-failure.jsonl"));
		await pi.emit("session_start", {}, ctx);

		const agentId = `agt_001_${fixedNow.toString(36)}`;
		const mkdirSync = fs.mkdirSync.bind(fs);
		vi.spyOn(fs, "mkdirSync").mockImplementation((targetPath, options) => {
			if (typeof targetPath === "string" && targetPath.endsWith(agentId)) {
				throw new Error("disk full");
			}

			return mkdirSync(targetPath, options as Parameters<typeof fs.mkdirSync>[1]);
		});

		const tool = getRegisteredTool(pi, "Subagent");
		const result = await tool.execute(
			"tool-call-mkdir-failure",
			{
				action: "spawn",
				prompt: "Do the work.",
				description: "Directory failure",
				subagent_type: "general-purpose",
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.content[0]?.text).toContain("Failed to prepare agent runtime directory: disk full");
		expect(tmux.killedSessions).toHaveLength(1);
		expect(tmux.sessionTargets.size).toBe(0);
		expect(processes.handles.size).toBe(0);
	});

	it("surfaces parent session runtime directory failures without crashing the extension", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:27:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const mkdirSync = fs.mkdirSync.bind(fs);
		const stateRoot = path.join(fakeHomeDir, ".ai", "pi-nexus");
		vi.spyOn(fs, "mkdirSync").mockImplementation((targetPath, options) => {
			if (typeof targetPath === "string" && targetPath.startsWith(stateRoot)) {
				throw new Error("home dir read only");
			}

			return mkdirSync(targetPath, options as Parameters<typeof fs.mkdirSync>[1]);
		});

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "state-failure.jsonl"));
		await expect(pi.emit("session_start", {}, ctx)).resolves.toBeUndefined();
		expect(ctx.notifications.at(-1)).toEqual({
			message: "pi-nexus parent session setup failed: failed to prepare parent session runtime directory: home dir read only",
			type: "error",
		});

		const tool = getRegisteredTool(pi, "Subagent");
		const toolResult = await tool.execute(
			"tool-call-state-failure",
			{
				action: "spawn",
				prompt: "Do the work.",
				description: "State failure",
				subagent_type: "general-purpose",
			},
			undefined,
			undefined,
			ctx,
		);
		expect(toolResult.content[0]?.text).toContain(
			"Failed to prepare parent session runtime: failed to prepare parent session runtime directory: home dir read only",
		);

		const command = getRegisteredCommand(pi, "subagents");
		await expect(command.handler("list", ctx)).resolves.toBeUndefined();
		expect(String(pi.sentMessages.at(-1)?.message.content ?? "")).toContain(
			"Failed to prepare parent session runtime: failed to prepare parent session runtime directory: home dir read only",
		);
	});

	it("shuts down managed runtimes and kills owned tmux sessions on session shutdown", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:30:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const ctx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "shutdown.jsonl"));
		await pi.emit("session_start", {}, ctx);

		const tool = getRegisteredTool(pi, "Subagent");
		await tool.execute(
			"tool-call-shutdown",
			{
				action: "spawn",
				prompt: "Stay alive.",
				description: "Shutdown cleanup",
				subagent_type: "general-purpose",
			},
			undefined,
			undefined,
			ctx,
		);

		const agentId = Array.from(processes.handles.keys())[0];
		expect(tmux.sessionTargets.size).toBe(1);

		await pi.emit("session_shutdown", {}, ctx);

		expect(processes.get(agentId).terminateReasons).toContain("shutdown");
		expect(sidecars.get(agentId).closeCount).toBe(1);
		expect(tmux.killedSessions).toHaveLength(1);
	});

	it("ignores shutdown events for sessions that are no longer active", async () => {
		const sidecars = new FakeSidecarSessions();
		const processes = new FakeProcesses();
		const tmux = new FakeTmuxRuntime();
		const pi = new FakePiApi();
		installParentExtension(pi, {
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			homeDir: fakeHomeDir,
			now: () => "2026-03-13T12:40:00.000Z",
			runTmuxCommand: (args) => tmux.run(args),
			sidecarSessions: sidecars,
			runtimeProcesses: processes,
		});

		const firstCtx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "first.jsonl"));
		await pi.emit("session_start", {}, firstCtx);

		const tool = getRegisteredTool(pi, "Subagent");
		await tool.execute(
			"tool-call-first",
			{
				action: "spawn",
				prompt: "Stay alive in first session.",
				description: "First session agent",
				subagent_type: "general-purpose",
			},
			undefined,
			undefined,
			firstCtx,
		);

		const firstAgentId = Array.from(processes.handles.keys())[0];
		expect(firstAgentId).toBeDefined();

		const secondCtx = new FakeExtensionContext(fakeRepoDir, path.join(fakeRepoDir, ".sessions", "second.jsonl"));
		await pi.emit("session_start", {}, secondCtx);
		expect(processes.get(firstAgentId).terminateReasons).toContain("shutdown");
		expect(sidecars.get(firstAgentId).closeCount).toBe(1);

		await tool.execute(
			"tool-call-second",
			{
				action: "spawn",
				prompt: "Stay alive in second session.",
				description: "Second session agent",
				subagent_type: "general-purpose",
			},
			undefined,
			undefined,
			secondCtx,
		);

		const secondAgentId = Array.from(processes.handles.keys()).find((agentId) => agentId !== firstAgentId);
		expect(secondAgentId).toBeDefined();
		expect(tmux.sessionTargets.size).toBe(1);

		await pi.emit("session_shutdown", {}, firstCtx);

		expect(processes.get(secondAgentId!).terminateReasons).toEqual([]);
		expect(sidecars.get(secondAgentId!).closeCount).toBe(0);
		expect(tmux.sessionTargets.size).toBe(1);
	});
});
