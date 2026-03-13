import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTmuxCommandRunner, installParentExtension } from "../src/parent-extension.js";
import type {
	RuntimeLaunchSpec,
	SidecarControlMessage,
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

	public constructor(
		public cwd: string,
		private readonly sessionFile: string,
	) {}

	public readonly sessionManager = {
		getSessionFile: () => this.sessionFile,
	};

	public readonly ui = {
		notify: (message: string, type?: "info" | "warning" | "error") => {
			this.notifications.push({ message, type });
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
	it("spawns named subagents and exposes /subagents list and focus output", async () => {
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

		const tool = getRegisteredTool(pi, "Agent");
		const result = await tool.execute(
			"tool-call-1",
			{
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
		expect(output).toContain("Use /subagents list or /subagents focus");

		const agentId = Array.from(processes.handles.keys())[0];
		expect(agentId).toMatch(/^agt_001_/);
		const launchSpec = processes.get(agentId).launchSpec;
		expect(launchSpec.initialPrompt).toContain("Research the codebase carefully");
		expect(launchSpec.tmuxTarget).toBe(`${tmux.killedSessions[0] ?? Array.from(tmux.sessionTargets.keys())[0]}:child`);

		const command = getRegisteredCommand(pi, "subagents");
		await command.handler("list", ctx);
		const listContent = String(pi.sentMessages.at(-1)?.message.content ?? "");
		expect(listContent).toContain(agentId);
		expect(listContent).toContain("Researcher (Researcher)");
		expect(listContent).toContain("posture=connecting");

		await command.handler(`focus ${agentId}`, ctx);
		const focusContent = String(pi.sentMessages.at(-1)?.message.content ?? "");
		expect(focusContent).toContain(`Subagent focus target for ${agentId}`);
		expect(focusContent).toContain("Focus command: if [ -n \"${TMUX:-}\" ]; then tmux switch-client");
		expect(focusContent).toContain("else tmux attach-session");
		expect(focusContent).toContain(launchSpec.tmuxTarget);
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

		const tool = getRegisteredTool(pi, "Agent");
		await tool.execute(
			"tool-call-bridge",
			{
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
		expect(pi.sentUserMessages.at(-1)).toEqual({
			content: expect.stringContaining("Subagent final_result"),
			options: { deliverAs: "followUp" },
		});
		expect(String(pi.sentUserMessages.at(-1)?.content)).toContain("Completed the task");
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

		const tool = getRegisteredTool(pi, "Agent");
		await tool.execute(
			"tool-call-stale",
			{
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
		expect(staleListContent).toContain("stale@2026-03-13T12:20:03.000Z");
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
		expect(refreshedListContent).toContain("markers=none");
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

		const tool = getRegisteredTool(pi, "Agent");
		const result = await tool.execute(
			"tool-call-mkdir-failure",
			{
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

		const tool = getRegisteredTool(pi, "Agent");
		const toolResult = await tool.execute(
			"tool-call-state-failure",
			{
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

		const tool = getRegisteredTool(pi, "Agent");
		await tool.execute(
			"tool-call-shutdown",
			{
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
});
