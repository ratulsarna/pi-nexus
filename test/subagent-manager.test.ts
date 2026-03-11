import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, beforeAll, afterAll } from "vitest";

import {
	createRuntimeLaunchSpec,
	type RuntimeBootstrapConfig,
	type RuntimeLaunchSpec,
	type SidecarControlMessage,
	type ValidationOutcome,
} from "../src/contracts.js";
import {
	SubagentManager,
	type ManagedProcessExit,
	type ManagedSubagentSpawnRequest,
	type SidecarSessionAdapter,
	type SidecarSessionHandle,
	type SubagentProcessAdapter,
	type SubagentProcessHandle,
} from "../src/subagent-manager.js";

let originalPath: string | undefined;
let originalHome: string | undefined;
let fakeBinDir = os.tmpdir();
let fakeRepoDir = os.tmpdir();
let fakePiPath = path.join(os.tmpdir(), "pi");
let fakeBootstrapExtensionPath = path.join(os.tmpdir(), "subagent-bootstrap.ts");
let launchSpecCounter = 0;

interface TimeCursor {
	next(): string;
}

interface SidecarSessionHandlers {
	onConnect: () => ValidationOutcome<unknown>;
	onMessage: (message: unknown) => ValidationOutcome<unknown>;
	onDisconnect: (reason?: string) => ValidationOutcome<unknown>;
}

class FakeSidecarSession<TData = unknown> implements SidecarSessionHandle<TData> {
	public readonly sent: SidecarControlMessage<TData>[] = [];
	public closeCount = 0;

	public constructor(
		private readonly handlers: SidecarSessionHandlers,
		private readonly options: {
			throwOnSend?: boolean;
		} = {},
	) {}

	public send(message: SidecarControlMessage<TData>): void {
		if (this.options.throwOnSend) {
			throw new Error("send exploded");
		}
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

	public disconnect(reason?: string): ValidationOutcome<unknown> {
		return this.handlers.onDisconnect(reason);
	}
}

class FakeSidecarSessions<TData = unknown> implements SidecarSessionAdapter<TData> {
	public readonly sessions = new Map<string, FakeSidecarSession<TData>>();

	public constructor(
		private readonly options: {
			fireConnectOnOpen?: boolean;
			throwOnSend?: boolean;
		} = {},
	) {}

	public openSession(_socketPath: string, handlers: SidecarSessionHandlers): SidecarSessionHandle<TData> {
		const session = new FakeSidecarSession<TData>(handlers, {
			throwOnSend: this.options.throwOnSend,
		});
		if (this.options.fireConnectOnOpen) {
			session.connect();
		}
		return session;
	}

	public register(agentId: string, handle: SidecarSessionHandle<TData>): void {
		this.sessions.set(agentId, handle as FakeSidecarSession<TData>);
	}

	public get(agentId: string): FakeSidecarSession<TData> {
		const session = this.sessions.get(agentId);
		if (!session) {
			throw new Error(`missing fake sidecar session for ${agentId}`);
		}

		return session;
	}
}

class FakeProcessHandle implements SubagentProcessHandle {
	public readonly terminateReasons: Array<"abort" | "shutdown"> = [];

	public constructor(
		private readonly exitHandler: (exit: ManagedProcessExit) => ValidationOutcome<unknown>,
	) {}

	public terminate(reason: "abort" | "shutdown"): void {
		this.terminateReasons.push(reason);
	}

	public exit(exit: ManagedProcessExit): ValidationOutcome<unknown> {
		return this.exitHandler(exit);
	}
}

class FakeProcesses implements SubagentProcessAdapter {
	public readonly handles = new Map<string, FakeProcessHandle>();

	public constructor(
		private readonly options: {
			fireExitOnLaunch?: ManagedProcessExit;
		} = {},
	) {}

	public launch(
		launchSpec: RuntimeLaunchSpec,
		handlers: { onExit: (exit: ManagedProcessExit) => ValidationOutcome<unknown> },
	): SubagentProcessHandle {
		const handle = new FakeProcessHandle(handlers.onExit);
		this.handles.set(launchSpec.agentId, handle);
		if (this.options.fireExitOnLaunch) {
			handle.exit(this.options.fireExitOnLaunch);
		}
		return handle;
	}

	public get(agentId: string): FakeProcessHandle {
		const handle = this.handles.get(agentId);
		if (!handle) {
			throw new Error(`missing fake process handle for ${agentId}`);
		}

		return handle;
	}
}

function createTimeCursor(...times: string[]): TimeCursor {
	const remaining = [...times];
	const last = remaining.at(-1) ?? "2026-03-11T12:00:00.000Z";
	return {
		next(): string {
			return remaining.shift() ?? last;
		},
	};
}

function makeBootstrap(agentId: string, runtimeDir: string): RuntimeBootstrapConfig {
	return {
		agentId,
		sessionPath: path.join(runtimeDir, `${agentId}.session.jsonl`),
		socketPath: path.join(runtimeDir, `${agentId}.sock`),
		tmuxMode: "pane",
		tmuxTarget: `main:${launchSpecCounter}.1`,
		initialPrompt: `Prompt for ${agentId}`,
		bootstrapExtensionPath: fakeBootstrapExtensionPath,
		cwd: fakeRepoDir,
		childMode: "interactive-cli",
	};
}

function createLaunchSpec(agentId: string): RuntimeLaunchSpec {
	const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, `runtime-${launchSpecCounter += 1}-`));
	const bootstrap = makeBootstrap(agentId, runtimeDir);
	const bootstrapConfigPath = path.join(runtimeDir, `${agentId}.bootstrap.json`);
	fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrap, null, 2)}\n`);
	const result = createRuntimeLaunchSpec(bootstrap, bootstrapConfigPath);
	if (!result.ok) {
		throw new Error(result.error);
	}

	return result.value;
}

function makeSpawnRequest(agentId: string): ManagedSubagentSpawnRequest {
	return {
		type: "general-purpose",
		description: `Test agent ${agentId}`,
		launchSpec: createLaunchSpec(agentId),
	};
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

function createManager(
	times: string[],
	options: {
		throwOnSessionOpened?: boolean;
		fireConnectOnOpen?: boolean;
		fireExitOnLaunch?: ManagedProcessExit;
		throwOnSend?: boolean;
	} = {},
) {
	const sidecars = new FakeSidecarSessions({
		fireConnectOnOpen: options.fireConnectOnOpen,
		throwOnSend: options.throwOnSend,
	});
	const processes = new FakeProcesses({
		fireExitOnLaunch: options.fireExitOnLaunch,
	});
	const clock = createTimeCursor(...times);
	const manager = new SubagentManager({
		now: () => clock.next(),
		sidecarSessions: {
			openSession(socketPath, handlers) {
				const session = sidecars.openSession(socketPath, handlers);
				return session;
			},
		},
		runtimeProcesses: processes,
		onSessionOpened(agentId, handle) {
			if (options.throwOnSessionOpened) {
				throw new Error("session registration exploded");
			}
			sidecars.register(agentId, handle);
		},
	});

	return { manager, sidecars, processes };
}

function expectOk<T>(result: ValidationOutcome<T>): T {
	if (!result.ok) {
		throw new Error(result.error);
	}
	expect(result.ok).toBe(true);

	return result.value;
}

beforeAll(() => {
	originalPath = process.env.PATH;
	originalHome = process.env.HOME;
	fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-manager-bin-"));
	fakeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-manager-repo-"));
	fakePiPath = path.join(fakeBinDir, "pi");
	fakeBootstrapExtensionPath = path.join(fakeRepoDir, "subagent-bootstrap.ts");
	fs.writeFileSync(fakePiPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	fs.writeFileSync(fakeBootstrapExtensionPath, "export {};\n");
	process.env.PATH = [fakeBinDir, originalPath].filter((value): value is string => typeof value === "string").join(path.delimiter);
	process.env.HOME = originalHome ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-manager-home-"));
});

afterAll(() => {
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}

	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}

	fs.rmSync(fakeBinDir, { recursive: true, force: true });
	fs.rmSync(fakeRepoDir, { recursive: true, force: true });
});

describe("SubagentManager", () => {
	it("creates a connecting record and sends hello on sidecar connect", () => {
		const { manager, sidecars, processes } = createManager([
			"2026-03-11T12:00:00.000Z",
			"2026-03-11T12:00:01.000Z",
		]);
		const request = makeSpawnRequest("agt_spawn");

		const spawnResult = expectOk(manager.spawn(request));

		expect(spawnResult.state).toBe("connecting");
		expect(spawnResult.startedAt).toBe("2026-03-11T12:00:00.000Z");
		expect(processes.get("agt_spawn").terminateReasons).toEqual([]);

		expectOk(sidecars.get("agt_spawn").connect());

		const sentHello = sidecars.get("agt_spawn").sent;
		expect(sentHello).toHaveLength(1);
		expect(sentHello[0]?.type).toBe("hello");
		expect(sentHello[0]?.seq).toBe(0);
		expect(expectOk(manager.getRecord("agt_spawn")).state).toBe("connecting");
		expect(expectOk(manager.getRecord("agt_spawn")).connectedAt).toBeUndefined();
	});

	it("rejects malformed spawn input without throwing", () => {
		const { manager } = createManager(["2026-03-11T11:59:59.000Z"]);

		expect(manager.spawn(null as unknown as ManagedSubagentSpawnRequest)).toEqual({
			ok: false,
			error: "spawn request must be an object",
		});
		expect(manager.spawn("bad" as unknown as ManagedSubagentSpawnRequest)).toEqual({
			ok: false,
			error: "spawn request must be an object",
		});
	});

	it("requires a valid ready handshake before trusting progress", () => {
		const { manager, sidecars } = createManager([
			"2026-03-11T12:01:00.000Z",
			"2026-03-11T12:01:01.000Z",
		]);
		const request = makeSpawnRequest("agt_ready");
		expectOk(manager.spawn(request));

		sidecars.get("agt_ready").connect();
		const prematureProgress = sidecars.get("agt_ready").message(
			makeEnvelope("agt_ready", "progress", 0, "2026-03-11T12:01:02.000Z", {
				summary: "too early",
			}),
		);
		expect(prematureProgress.ok).toBe(false);
		expect(expectOk(manager.getRecord("agt_ready")).state).toBe("connecting");

		expectOk(sidecars.get("agt_ready").message(
			makeEnvelope("agt_ready", "ready", 0, "2026-03-11T12:01:03.000Z", {
				pid: 1234,
				sessionPath: request.launchSpec.sessionPath,
				tmuxTarget: request.launchSpec.tmuxTarget,
			}),
		));
		expect(expectOk(manager.getRecord("agt_ready")).state).toBe("ready");
		expect(expectOk(manager.getRecord("agt_ready")).connectedAt).toBe("2026-03-11T12:01:03.000Z");
	});

	it("preserves distinct steer and follow_up control semantics", () => {
		const { manager, sidecars, processes } = createManager([
			"2026-03-11T12:02:00.000Z",
			"2026-03-11T12:02:01.000Z",
			"2026-03-11T12:02:02.000Z",
			"2026-03-11T12:02:03.000Z",
		]);
		const request = makeSpawnRequest("agt_controls");
		expectOk(manager.spawn(request));
		sidecars.get("agt_controls").connect();
		expectOk(sidecars.get("agt_controls").message(
			makeEnvelope("agt_controls", "ready", 0, "2026-03-11T12:02:04.000Z", {
				pid: 5678,
				sessionPath: request.launchSpec.sessionPath,
				tmuxTarget: request.launchSpec.tmuxTarget,
			}),
		));

		expectOk(manager.sendSteer("agt_controls", "Steer now"));
		expectOk(manager.sendFollowUp("agt_controls", "Follow up later"));
		expectOk(manager.sendAbort("agt_controls"));
		expect(sidecars.get("agt_controls").sent.map((message) => message.type)).toEqual([
			"hello",
			"steer",
			"follow_up",
			"abort",
		]);
		expect(sidecars.get("agt_controls").sent.map((message) => message.seq)).toEqual([0, 1, 2, 3]);
		expect(processes.get("agt_controls").terminateReasons).toEqual([]);
	});

	it("updates authoritative state from accepted child events", () => {
		const { manager, sidecars } = createManager([
			"2026-03-11T12:03:00.000Z",
			"2026-03-11T12:03:01.000Z",
		]);
		const request = makeSpawnRequest("agt_events");
		expectOk(manager.spawn(request));
		sidecars.get("agt_events").connect();
		expectOk(sidecars.get("agt_events").message(
			makeEnvelope("agt_events", "ready", 0, "2026-03-11T12:03:02.000Z", {
				pid: 9101,
				sessionPath: request.launchSpec.sessionPath,
				tmuxTarget: request.launchSpec.tmuxTarget,
			}),
		));

		expectOk(sidecars.get("agt_events").message(
			makeEnvelope("agt_events", "progress", 1, "2026-03-11T12:03:03.000Z", {
				summary: "working",
			}),
		));
		expect(expectOk(manager.getRecord("agt_events")).state).toBe("running");
		expect(expectOk(manager.getRecord("agt_events")).lastProgressReport?.summary).toBe("working");

		expectOk(sidecars.get("agt_events").message(
			makeEnvelope("agt_events", "needs_input", 2, "2026-03-11T12:03:04.000Z", {
				question: "Need a decision",
				kind: "decision",
			}),
		));
		expect(expectOk(manager.getRecord("agt_events")).state).toBe("waiting");
		expect(expectOk(manager.getRecord("agt_events")).pendingInputRequest?.summary).toBe("Need a decision");

		expectOk(sidecars.get("agt_events").message(
			makeEnvelope("agt_events", "user_intervened", 3, "2026-03-11T12:03:05.000Z", {
				source: "tmux",
				mode: "direct-chat",
			}),
		));
		expect(expectOk(manager.getRecord("agt_events")).userIntervened?.recordedAt).toBe("2026-03-11T12:03:05.000Z");

		expectOk(sidecars.get("agt_events").message(
			makeEnvelope("agt_events", "progress", 4, "2026-03-11T12:03:06.000Z", {
				summary: "working again",
				data: null,
			}),
		));
		expect(expectOk(manager.getRecord("agt_events")).state).toBe("running");
		expect(expectOk(manager.getRecord("agt_events")).pendingInputRequest).toBeUndefined();

		expectOk(sidecars.get("agt_events").message(
			makeEnvelope("agt_events", "final_result", 5, "2026-03-11T12:03:07.000Z", {
				summary: "all done",
				data: null,
			}),
		));
		expect(expectOk(manager.getRecord("agt_events")).state).toBe("completed");
		expect(expectOk(manager.getRecord("agt_events")).completedAt).toBe("2026-03-11T12:03:07.000Z");
		expect(expectOk(manager.getRecord("agt_events")).finalResult?.summary).toBe("all done");
	});

	it("rejects duplicate and stale child seq values without mutating authoritative state", () => {
		const { manager, sidecars } = createManager([
			"2026-03-11T12:04:00.000Z",
			"2026-03-11T12:04:01.000Z",
		]);
		const request = makeSpawnRequest("agt_seq");
		expectOk(manager.spawn(request));
		sidecars.get("agt_seq").connect();
		expectOk(sidecars.get("agt_seq").message(
			makeEnvelope("agt_seq", "ready", 0, "2026-03-11T12:04:02.000Z", {
				pid: 2468,
				sessionPath: request.launchSpec.sessionPath,
				tmuxTarget: request.launchSpec.tmuxTarget,
			}),
		));

		expectOk(sidecars.get("agt_seq").message(
			makeEnvelope("agt_seq", "progress", 1, "2026-03-11T12:04:03.000Z", {
				summary: "first",
			}),
		));
		const duplicate = sidecars.get("agt_seq").message(
			makeEnvelope("agt_seq", "progress", 1, "2026-03-11T12:04:04.000Z", {
				summary: "duplicate",
			}),
		);
		const stale = sidecars.get("agt_seq").message(
			makeEnvelope("agt_seq", "progress", 0, "2026-03-11T12:04:05.000Z", {
				summary: "stale",
			}),
		);

		expect(duplicate.ok).toBe(false);
		expect(stale.ok).toBe(false);
		expect(expectOk(manager.getRecord("agt_seq")).lastProgressReport?.summary).toBe("first");
	});

	it("rejects malformed inbound child traffic without mutating authoritative state", () => {
		const { manager, sidecars } = createManager([
			"2026-03-11T12:04:30.000Z",
			"2026-03-11T12:04:31.000Z",
		]);
		const request = makeSpawnRequest("agt_malformed");
		expectOk(manager.spawn(request));
		expectOk(sidecars.get("agt_malformed").connect());
		expectOk(sidecars.get("agt_malformed").message(
			makeEnvelope("agt_malformed", "ready", 0, "2026-03-11T12:04:32.000Z", {
				pid: 8642,
				sessionPath: request.launchSpec.sessionPath,
				tmuxTarget: request.launchSpec.tmuxTarget,
			}),
		));
		expectOk(sidecars.get("agt_malformed").message(
			makeEnvelope("agt_malformed", "progress", 1, "2026-03-11T12:04:33.000Z", {
				summary: "trusted progress",
			}),
		));

		const before = expectOk(manager.getRecord("agt_malformed"));
		const malformed = sidecars.get("agt_malformed").message({
			version: 1,
			agentId: "agt_malformed",
			type: "progress",
			seq: 2,
			time: "2026-03-11T12:04:34.000Z",
			payload: {},
		});

		expect(malformed.ok).toBe(false);
		if (!malformed.ok) {
			expect(malformed.error).toContain("progress.payload.summary");
		}

		const after = expectOk(manager.getRecord("agt_malformed"));
		expect(after).toEqual(before);
	});

	it("rejects uncloneable inbound report data without mutating authoritative state", () => {
		const { manager, sidecars } = createManager([
			"2026-03-11T12:04:35.000Z",
			"2026-03-11T12:04:36.000Z",
		]);
		const request = makeSpawnRequest("agt_uncloneable");
		expectOk(manager.spawn(request));
		expectOk(sidecars.get("agt_uncloneable").connect());
		expectOk(sidecars.get("agt_uncloneable").message(
			makeEnvelope("agt_uncloneable", "ready", 0, "2026-03-11T12:04:37.000Z", {
				pid: 8643,
				sessionPath: request.launchSpec.sessionPath,
				tmuxTarget: request.launchSpec.tmuxTarget,
			}),
		));
		expectOk(sidecars.get("agt_uncloneable").message(
			makeEnvelope("agt_uncloneable", "progress", 1, "2026-03-11T12:04:38.000Z", {
				summary: "trusted progress",
			}),
		));

		const before = expectOk(manager.getRecord("agt_uncloneable"));
		const uncloneable = sidecars.get("agt_uncloneable").message(
			makeEnvelope("agt_uncloneable", "progress", 2, "2026-03-11T12:04:39.000Z", {
				summary: "bad payload",
				data: { fn: () => "nope" },
			}),
		);

		expect(uncloneable.ok).toBe(false);
		if (!uncloneable.ok) {
			expect(uncloneable.error).toContain("progress.data must be structured-cloneable");
		}

		const after = expectOk(manager.getRecord("agt_uncloneable"));
		expect(after).toEqual(before);
	});

	it("rejects wrong-direction inbound traffic without mutating authoritative state", () => {
		const { manager, sidecars } = createManager([
			"2026-03-11T12:04:40.000Z",
			"2026-03-11T12:04:41.000Z",
		]);
		const request = makeSpawnRequest("agt_direction");
		expectOk(manager.spawn(request));
		expectOk(sidecars.get("agt_direction").connect());
		expectOk(sidecars.get("agt_direction").message(
			makeEnvelope("agt_direction", "ready", 0, "2026-03-11T12:04:42.000Z", {
				pid: 9753,
				sessionPath: request.launchSpec.sessionPath,
				tmuxTarget: request.launchSpec.tmuxTarget,
			}),
		));
		expectOk(sidecars.get("agt_direction").message(
			makeEnvelope("agt_direction", "progress", 1, "2026-03-11T12:04:43.000Z", {
				summary: "still trusted",
			}),
		));

		const before = expectOk(manager.getRecord("agt_direction"));
		const wrongDirection = sidecars.get("agt_direction").message(
			makeEnvelope("agt_direction", "steer", 2, "2026-03-11T12:04:44.000Z", {
				message: "this should never arrive inbound",
			}),
		);

		expect(wrongDirection.ok).toBe(false);
		if (!wrongDirection.ok) {
			expect(wrongDirection.error).toContain("sidecar event message type");
		}

		const after = expectOk(manager.getRecord("agt_direction"));
		expect(after).toEqual(before);
	});

	it("honors terminal child state updates and avoids later exit misclassification", () => {
		const stopped = createManager([
			"2026-03-11T12:04:50.000Z",
			"2026-03-11T12:04:51.000Z",
		]);
		const stoppedRequest = makeSpawnRequest("agt_state_stopped");
		expectOk(stopped.manager.spawn(stoppedRequest));
		expectOk(stopped.sidecars.get("agt_state_stopped").connect());
		expectOk(stopped.sidecars.get("agt_state_stopped").message(
			makeEnvelope("agt_state_stopped", "ready", 0, "2026-03-11T12:04:52.000Z", {
				pid: 1112,
				sessionPath: stoppedRequest.launchSpec.sessionPath,
				tmuxTarget: stoppedRequest.launchSpec.tmuxTarget,
			}),
		));
		expectOk(stopped.sidecars.get("agt_state_stopped").message(
			makeEnvelope("agt_state_stopped", "state", 1, "2026-03-11T12:04:53.000Z", {
				status: "stopped",
			}),
		));
		expect(expectOk(stopped.manager.getRecord("agt_state_stopped")).state).toBe("stopped");
		expectOk(stopped.processes.get("agt_state_stopped").exit({ code: 0, signal: null }));
		expect(expectOk(stopped.manager.getRecord("agt_state_stopped")).state).toBe("stopped");

		const failed = createManager([
			"2026-03-11T12:04:54.000Z",
			"2026-03-11T12:04:55.000Z",
		]);
		const failedRequest = makeSpawnRequest("agt_state_failed");
		expectOk(failed.manager.spawn(failedRequest));
		expectOk(failed.sidecars.get("agt_state_failed").connect());
		expectOk(failed.sidecars.get("agt_state_failed").message(
			makeEnvelope("agt_state_failed", "ready", 0, "2026-03-11T12:04:56.000Z", {
				pid: 1113,
				sessionPath: failedRequest.launchSpec.sessionPath,
				tmuxTarget: failedRequest.launchSpec.tmuxTarget,
			}),
		));
		expectOk(failed.sidecars.get("agt_state_failed").message(
			makeEnvelope("agt_state_failed", "state", 1, "2026-03-11T12:04:57.000Z", {
				status: "failed",
			}),
		));
		expect(expectOk(failed.manager.getRecord("agt_state_failed")).state).toBe("failed");

		const completed = createManager([
			"2026-03-11T12:04:58.000Z",
			"2026-03-11T12:04:59.000Z",
			"2026-03-11T12:05:02.000Z",
		]);
		const completedRequest = makeSpawnRequest("agt_state_completed");
		expectOk(completed.manager.spawn(completedRequest));
		expectOk(completed.sidecars.get("agt_state_completed").connect());
		expectOk(completed.sidecars.get("agt_state_completed").message(
			makeEnvelope("agt_state_completed", "ready", 0, "2026-03-11T12:05:00.000Z", {
				pid: 1114,
				sessionPath: completedRequest.launchSpec.sessionPath,
				tmuxTarget: completedRequest.launchSpec.tmuxTarget,
			}),
		));
		expectOk(completed.sidecars.get("agt_state_completed").message(
			makeEnvelope("agt_state_completed", "state", 1, "2026-03-11T12:05:01.000Z", {
				status: "completed",
			}),
		));
		expectOk(completed.processes.get("agt_state_completed").exit({ code: 0, signal: null }));
		const completedRecord = expectOk(completed.manager.getRecord("agt_state_completed"));
		expect(completedRecord.state).toBe("stopped");
		expect(completedRecord.error).toBeUndefined();
	});

	it("marks a ready agent degraded on disconnect and rejects further trusted controls", () => {
		const { manager, sidecars } = createManager([
			"2026-03-11T12:05:00.000Z",
			"2026-03-11T12:05:01.000Z",
			"2026-03-11T12:05:04.000Z",
		]);
		const request = makeSpawnRequest("agt_degraded");
		expectOk(manager.spawn(request));
		sidecars.get("agt_degraded").connect();
		expectOk(sidecars.get("agt_degraded").message(
			makeEnvelope("agt_degraded", "ready", 0, "2026-03-11T12:05:03.000Z", {
				pid: 1357,
				sessionPath: request.launchSpec.sessionPath,
				tmuxTarget: request.launchSpec.tmuxTarget,
			}),
		));

		expectOk(sidecars.get("agt_degraded").disconnect("lost socket"));
		expect(expectOk(manager.getRecord("agt_degraded")).state).toBe("degraded");
		expect(manager.sendSteer("agt_degraded", "no longer trusted").ok).toBe(false);
		expect(
			sidecars.get("agt_degraded").message(
				makeEnvelope("agt_degraded", "progress", 1, "2026-03-11T12:05:04.000Z", {
					summary: "too late",
				}),
			).ok,
		).toBe(false);
	});

	it("clears degradedAt when degraded agents later fail or stop", () => {
		const first = createManager([
			"2026-03-11T12:05:10.000Z",
			"2026-03-11T12:05:11.000Z",
			"2026-03-11T12:05:14.000Z",
			"2026-03-11T12:05:15.000Z",
		]);
		const firstRequest = makeSpawnRequest("agt_degraded_fail");
		expectOk(first.manager.spawn(firstRequest));
		expectOk(first.sidecars.get("agt_degraded_fail").connect());
		expectOk(first.sidecars.get("agt_degraded_fail").message(
			makeEnvelope("agt_degraded_fail", "ready", 0, "2026-03-11T12:05:12.000Z", {
				pid: 1111,
				sessionPath: firstRequest.launchSpec.sessionPath,
				tmuxTarget: firstRequest.launchSpec.tmuxTarget,
			}),
		));
		expectOk(first.sidecars.get("agt_degraded_fail").disconnect("lost trust"));
		expectOk(first.processes.get("agt_degraded_fail").exit({ code: 1, signal: null }));
		const failedRecord = expectOk(first.manager.getRecord("agt_degraded_fail"));
		expect(failedRecord.state).toBe("failed");
		expect(failedRecord.degradedAt).toBeUndefined();

		const second = createManager([
			"2026-03-11T12:05:20.000Z",
			"2026-03-11T12:05:21.000Z",
			"2026-03-11T12:05:24.000Z",
			"2026-03-11T12:05:25.000Z",
		]);
		const secondRequest = makeSpawnRequest("agt_degraded_stop");
		expectOk(second.manager.spawn(secondRequest));
		expectOk(second.sidecars.get("agt_degraded_stop").connect());
		expectOk(second.sidecars.get("agt_degraded_stop").message(
			makeEnvelope("agt_degraded_stop", "ready", 0, "2026-03-11T12:05:22.000Z", {
				pid: 2222,
				sessionPath: secondRequest.launchSpec.sessionPath,
				tmuxTarget: secondRequest.launchSpec.tmuxTarget,
			}),
		));
		expectOk(second.sidecars.get("agt_degraded_stop").disconnect("lost trust"));
		expectOk(second.manager.shutdownAll());
		const stoppedRecord = expectOk(second.manager.getRecord("agt_degraded_stop"));
		expect(stoppedRecord.state).toBe("stopped");
		expect(stoppedRecord.degradedAt).toBeUndefined();
	});

	it("marks pre-ready disconnects and unexpected exits as failures", () => {
		const first = createManager([
			"2026-03-11T12:06:00.000Z",
			"2026-03-11T12:06:01.000Z",
		]);
		expectOk(first.manager.spawn(makeSpawnRequest("agt_fail_disconnect")));
		expectOk(first.sidecars.get("agt_fail_disconnect").disconnect("no handshake"));
		expect(expectOk(first.manager.getRecord("agt_fail_disconnect")).state).toBe("failed");
		expect(expectOk(first.manager.getRecord("agt_fail_disconnect")).error?.message).toContain("before ready");

		const second = createManager([
			"2026-03-11T12:06:10.000Z",
			"2026-03-11T12:06:11.000Z",
		]);
		expectOk(second.manager.spawn(makeSpawnRequest("agt_fail_exit")));
		expectOk(second.processes.get("agt_fail_exit").exit({ code: 1, signal: null }));
		expect(expectOk(second.manager.getRecord("agt_fail_exit")).state).toBe("failed");
		expect(expectOk(second.manager.getRecord("agt_fail_exit")).error?.message).toContain("exited");
	});

	it("returns a validation error and cleans up when onSessionOpened throws", () => {
		const { manager, processes } = createManager(
			["2026-03-11T12:06:20.000Z"],
			{ throwOnSessionOpened: true },
		);
		const request = makeSpawnRequest("agt_session_hook");
		const spawnResult = manager.spawn(request);

		expect(spawnResult.ok).toBe(false);
		if (!spawnResult.ok) {
			expect(spawnResult.error).toContain("onSessionOpened failed");
		}
		expect(processes.get("agt_session_hook").terminateReasons).toEqual(["shutdown"]);
		expect(manager.getRecord("agt_session_hook").ok).toBe(false);
	});

	it("handles re-entrant openSession and launch callbacks after runtime registration", () => {
		const connected = createManager(
			["2026-03-11T12:06:30.000Z", "2026-03-11T12:06:31.000Z"],
			{ fireConnectOnOpen: true },
		);
		const connectedRequest = makeSpawnRequest("agt_reentrant_connect");
		const connectedSpawn = expectOk(connected.manager.spawn(connectedRequest));
		expect(connectedSpawn.state).toBe("connecting");
		expect(connected.sidecars.get("agt_reentrant_connect").sent.map((message) => message.type)).toEqual(["hello"]);

		const exited = createManager(
			["2026-03-11T12:06:40.000Z", "2026-03-11T12:06:41.000Z"],
			{ fireExitOnLaunch: { code: 1, signal: null } },
		);
		const exitedRequest = makeSpawnRequest("agt_reentrant_exit");
		const exitedSpawn = expectOk(exited.manager.spawn(exitedRequest));
		expect(exitedSpawn.state).toBe("failed");
		expect(expectOk(exited.manager.getRecord("agt_reentrant_exit")).state).toBe("failed");
		expect(expectOk(exited.manager.getRecord("agt_reentrant_exit")).error?.message).toContain("exited");
	});

	it("cleans up and unregisters the runtime when a deferred spawn callback fails", () => {
		const { manager, sidecars, processes } = createManager(
			["2026-03-11T12:06:50.000Z", "2026-03-11T12:06:51.000Z"],
			{ fireConnectOnOpen: true, throwOnSend: true },
		);
		const request = makeSpawnRequest("agt_deferred_failure");
		const spawnResult = manager.spawn(request);

		expect(spawnResult.ok).toBe(false);
		if (!spawnResult.ok) {
			expect(spawnResult.error).toContain("failed to send hello");
		}
		expect(processes.get("agt_deferred_failure").terminateReasons).toEqual(["shutdown"]);
		expect(sidecars.get("agt_deferred_failure").closeCount).toBe(1);
		expect(manager.getRecord("agt_deferred_failure").ok).toBe(false);
	});

	it("normalizes intentional shutdown to stopped and treats empty cleanup as a no-op", () => {
		const { manager, sidecars, processes } = createManager([
			"2026-03-11T12:07:00.000Z",
			"2026-03-11T12:07:01.000Z",
			"2026-03-11T12:07:06.000Z",
			"2026-03-11T12:07:07.000Z",
		]);
		const request = makeSpawnRequest("agt_shutdown");
		expectOk(manager.spawn(request));
		sidecars.get("agt_shutdown").connect();
		expectOk(sidecars.get("agt_shutdown").message(
			makeEnvelope("agt_shutdown", "ready", 0, "2026-03-11T12:07:04.000Z", {
				pid: 3333,
				sessionPath: request.launchSpec.sessionPath,
				tmuxTarget: request.launchSpec.tmuxTarget,
			}),
		));
		expectOk(sidecars.get("agt_shutdown").message(
			makeEnvelope("agt_shutdown", "progress", 1, "2026-03-11T12:07:05.000Z", {
				summary: "running",
			}),
		));

		expectOk(manager.shutdownAll());
		expect(expectOk(manager.getRecord("agt_shutdown")).state).toBe("stopped");
		expect(expectOk(manager.getRecord("agt_shutdown")).stoppedAt).toBe("2026-03-11T12:07:06.000Z");
		expect(processes.get("agt_shutdown").terminateReasons).toEqual(["shutdown"]);
		expect(sidecars.get("agt_shutdown").closeCount).toBe(1);

		const emptyManager = createManager(["2026-03-11T12:07:10.000Z"]).manager;
		expect(expectOk(emptyManager.shutdownAll())).toEqual([]);
	});

	it("still terminates and closes terminal runtimes during shutdownAll", () => {
		const completed = createManager([
			"2026-03-11T12:07:20.000Z",
			"2026-03-11T12:07:21.000Z",
		]);
		const completedRequest = makeSpawnRequest("agt_shutdown_completed");
		expectOk(completed.manager.spawn(completedRequest));
		expectOk(completed.sidecars.get("agt_shutdown_completed").connect());
		expectOk(completed.sidecars.get("agt_shutdown_completed").message(
			makeEnvelope("agt_shutdown_completed", "ready", 0, "2026-03-11T12:07:22.000Z", {
				pid: 4444,
				sessionPath: completedRequest.launchSpec.sessionPath,
				tmuxTarget: completedRequest.launchSpec.tmuxTarget,
			}),
		));
		expectOk(completed.sidecars.get("agt_shutdown_completed").message(
			makeEnvelope("agt_shutdown_completed", "progress", 1, "2026-03-11T12:07:23.000Z", {
				summary: "done",
			}),
		));
		expectOk(completed.sidecars.get("agt_shutdown_completed").message(
			makeEnvelope("agt_shutdown_completed", "final_result", 2, "2026-03-11T12:07:24.000Z", {
				summary: "finished",
				data: null,
			}),
		));

		const failed = createManager([
			"2026-03-11T12:07:30.000Z",
			"2026-03-11T12:07:33.000Z",
		]);
		const failedRequest = makeSpawnRequest("agt_shutdown_failed");
		expectOk(failed.manager.spawn(failedRequest));
		expectOk(failed.sidecars.get("agt_shutdown_failed").connect());
		expectOk(failed.sidecars.get("agt_shutdown_failed").message(
			makeEnvelope("agt_shutdown_failed", "ready", 0, "2026-03-11T12:07:32.000Z", {
				pid: 5555,
				sessionPath: failedRequest.launchSpec.sessionPath,
				tmuxTarget: failedRequest.launchSpec.tmuxTarget,
			}),
		));
		expectOk(failed.processes.get("agt_shutdown_failed").exit({ code: 1, signal: null }));

		expectOk(completed.manager.shutdownAll());
		expectOk(failed.manager.shutdownAll());

		expect(completed.processes.get("agt_shutdown_completed").terminateReasons).toEqual(["shutdown"]);
		expect(completed.sidecars.get("agt_shutdown_completed").closeCount).toBe(1);
		expect(expectOk(completed.manager.getRecord("agt_shutdown_completed")).state).toBe("completed");

		expect(failed.processes.get("agt_shutdown_failed").terminateReasons).toEqual(["shutdown"]);
		expect(failed.sidecars.get("agt_shutdown_failed").closeCount).toBe(1);
		expect(expectOk(failed.manager.getRecord("agt_shutdown_failed")).state).toBe("failed");
	});

	it("fails deterministically for unknown agent activity", () => {
		const { manager } = createManager(["2026-03-11T12:08:00.000Z"]);
		expect(manager.getRecord("missing").ok).toBe(false);
		expect(manager.sendSteer("missing", "nope").ok).toBe(false);
		expect(manager.handleSidecarConnect("missing").ok).toBe(false);
		expect(manager.handleSidecarMessage("missing", {}).ok).toBe(false);
		expect(manager.handleSidecarDisconnect("missing", "gone").ok).toBe(false);
	});
});
