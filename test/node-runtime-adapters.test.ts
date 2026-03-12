import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RuntimeLaunchSpec } from "../src/contracts.js";
import { NodeSidecarSessionAdapter, TmuxSubagentProcessAdapter } from "../src/node-runtime-adapters.js";

let originalPath: string | undefined;
let fakeRootDir = os.tmpdir();
let fakeBinDir = os.tmpdir();
let fakePiPath = path.join(os.tmpdir(), "pi");

beforeAll(() => {
	originalPath = process.env.PATH;
	fakeRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-node-runtime-"));
	fakeBinDir = path.join(fakeRootDir, "bin");
	fs.mkdirSync(fakeBinDir, { recursive: true });

const fakeTmuxPath = path.join(fakeBinDir, "tmux");
	fs.writeFileSync(
		fakeTmuxPath,
		`#!/bin/sh
counter_file="\${TMUX_FAKE_COUNTER_FILE:-}"
log_file="\${TMUX_FAKE_LOG_FILE:-}"
if [ -n "$log_file" ]; then
	printf '%s\\n' "$*" >> "$log_file"
fi
if [ -n "$counter_file" ]; then
	count=0
	if [ -f "$counter_file" ]; then
		count=$(cat "$counter_file")
	fi
	count=$((count + 1))
	printf '%s' "$count" > "$counter_file"
else
	count=1
fi
if [ "\${TMUX_FAKE_FAIL_ON_CALL:-}" = "$count" ]; then
	exit 1
fi
exit 0
`,
		{ mode: 0o755 },
	);

	fakePiPath = path.join(fakeBinDir, "pi");
	fs.writeFileSync(fakePiPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

	process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ""}`;
});

afterAll(() => {
	process.env.PATH = originalPath;
	fs.rmSync(fakeRootDir, { recursive: true, force: true });
});

function makeLaunchSpec(overrides: Partial<RuntimeLaunchSpec> = {}): RuntimeLaunchSpec {
	const runtimeDir = fs.mkdtempSync(path.join(fakeRootDir, "runtime-"));
	const sessionPath = path.join(runtimeDir, "session.jsonl");
	const socketPath = path.join(runtimeDir, "bridge.sock");
	const bootstrapExtensionPath = path.join(runtimeDir, "bootstrap-extension.ts");
	const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
	fs.writeFileSync(bootstrapExtensionPath, "export {};\n");
	fs.writeFileSync(bootstrapConfigPath, "{}\n");

	return {
		agentId: "agent-1",
		initialPrompt: "hello",
		command: fakePiPath,
		args: ["--session", sessionPath, "--extension", bootstrapExtensionPath],
		env: {
			HOME: runtimeDir,
			PATH: process.env.PATH ?? "",
			PI_SUBAGENT_BOOTSTRAP_CONFIG: bootstrapConfigPath,
		},
		cwd: runtimeDir,
		sessionPath,
		socketPath,
		tmuxMode: "pane",
		tmuxTarget: "session:1.1",
		bootstrapConfigPath,
		bootstrapExtensionPath,
		childMode: "interactive-cli",
		...overrides,
	};
}

describe("TmuxSubagentProcessAdapter", () => {
	it("writes launch env through env -i so non-identifier env keys stay safe", () => {
		const exitMarkerDir = fs.mkdtempSync(path.join(fakeRootDir, "tmux-env-"));
		const adapter = new TmuxSubagentProcessAdapter({
			exitMarkerDir,
			pollIntervalMs: 60_000,
		});
		const handle = adapter.launch(
			makeLaunchSpec({
				env: {
					HOME: exitMarkerDir,
					PATH: process.env.PATH ?? "",
					"BAD.KEY": "value with spaces",
					"DASH-NAME": "still okay",
				},
			}),
			{ onExit() {} },
		);

		const launchEntries = fs.readdirSync(exitMarkerDir, { withFileTypes: true });
		expect(launchEntries).toHaveLength(1);
		expect(launchEntries[0]?.isDirectory()).toBe(true);

		const launchDir = path.join(exitMarkerDir, launchEntries[0]!.name);
		const script = fs.readFileSync(path.join(launchDir, "launch.sh"), "utf8");
		expect(script).toContain("env -i");
		expect(script).toContain("'BAD.KEY=value with spaces'");
		expect(script).toContain("'DASH-NAME=still okay'");
		expect(script).not.toContain("export BAD.KEY=");
		expect(script).not.toContain("export DASH-NAME=");

		handle.terminate("shutdown");
	});

	it("confines launch artifacts inside exitMarkerDir even when agentId contains traversal text", () => {
		const parentDir = fs.mkdtempSync(path.join(fakeRootDir, "tmux-paths-"));
		const exitMarkerDir = path.join(parentDir, "markers");
		const adapter = new TmuxSubagentProcessAdapter({
			exitMarkerDir,
			pollIntervalMs: 60_000,
		});
		const handle = adapter.launch(
			makeLaunchSpec({
				agentId: "../escaped",
			}),
			{ onExit() {} },
		);

		expect(fs.readdirSync(parentDir).sort()).toEqual(["markers"]);

		const launchEntries = fs.readdirSync(exitMarkerDir, { withFileTypes: true });
		expect(launchEntries).toHaveLength(1);
		expect(launchEntries[0]?.isDirectory()).toBe(true);

		const launchDir = path.join(exitMarkerDir, launchEntries[0]!.name);
		expect(path.dirname(launchDir)).toBe(exitMarkerDir);
		expect(fs.existsSync(path.join(launchDir, "launch.sh"))).toBe(true);

		handle.terminate("shutdown");
	});

	it("rejects tmux launch env keys that cannot be represented safely", () => {
		const exitMarkerDir = fs.mkdtempSync(path.join(fakeRootDir, "tmux-invalid-env-"));
		const adapter = new TmuxSubagentProcessAdapter({
			exitMarkerDir,
			pollIntervalMs: 60_000,
		});

		expect(() =>
			adapter.launch(
				makeLaunchSpec({
					env: {
						HOME: exitMarkerDir,
						PATH: process.env.PATH ?? "",
						"BAD=KEY": "value",
					},
				}),
				{ onExit() {} },
			),
		).toThrow("launch env key must not contain =: BAD=KEY");
		expect(fs.readdirSync(exitMarkerDir)).toEqual([]);
	});

	it("cleans launch artifacts if the first tmux send-keys call throws", () => {
		const exitMarkerDir = fs.mkdtempSync(path.join(fakeRootDir, "tmux-first-fail-"));
		const counterPath = path.join(exitMarkerDir, "tmux-counter.txt");
		process.env.TMUX_FAKE_COUNTER_FILE = counterPath;
		process.env.TMUX_FAKE_FAIL_ON_CALL = "1";
		try {
			const adapter = new TmuxSubagentProcessAdapter({
				exitMarkerDir,
				pollIntervalMs: 60_000,
			});

			expect(() => adapter.launch(makeLaunchSpec(), { onExit() {} })).toThrow(
				"tmux command failed: tmux send-keys -t session:1.1 -l",
			);
			expect(fs.readdirSync(exitMarkerDir).sort()).toEqual(["tmux-counter.txt"]);
		} finally {
			delete process.env.TMUX_FAKE_COUNTER_FILE;
			delete process.env.TMUX_FAKE_FAIL_ON_CALL;
		}
	});

	it("cleans launch artifacts if the second tmux send-keys call throws", () => {
		const exitMarkerDir = fs.mkdtempSync(path.join(fakeRootDir, "tmux-second-fail-"));
		const counterPath = path.join(exitMarkerDir, "tmux-counter.txt");
		process.env.TMUX_FAKE_COUNTER_FILE = counterPath;
		process.env.TMUX_FAKE_FAIL_ON_CALL = "2";
		try {
			const adapter = new TmuxSubagentProcessAdapter({
				exitMarkerDir,
				pollIntervalMs: 60_000,
			});

			expect(() => adapter.launch(makeLaunchSpec(), { onExit() {} })).toThrow(
				"tmux command failed: tmux send-keys -t session:1.1 Enter",
			);
			expect(fs.readdirSync(exitMarkerDir).sort()).toEqual(["tmux-counter.txt"]);
		} finally {
			delete process.env.TMUX_FAKE_COUNTER_FILE;
			delete process.env.TMUX_FAKE_FAIL_ON_CALL;
		}
	});

	it("still finalizes terminate cleanup and exit reporting if tmux kill throws", () => {
		const exitMarkerDir = fs.mkdtempSync(path.join(fakeRootDir, "tmux-terminate-fail-"));
		const counterPath = path.join(exitMarkerDir, "tmux-counter.txt");
		process.env.TMUX_FAKE_COUNTER_FILE = counterPath;
		process.env.TMUX_FAKE_FAIL_ON_CALL = "3";
		try {
			const exits: Array<{ code: number | null; signal: string | null }> = [];
			const adapter = new TmuxSubagentProcessAdapter({
				exitMarkerDir,
				pollIntervalMs: 60_000,
			});
			const handle = adapter.launch(makeLaunchSpec(), {
				onExit(exit) {
					exits.push(exit);
				},
			});

			expect(() => handle.terminate("shutdown")).toThrow("tmux command failed: tmux kill-pane -t session:1.1");
			expect(exits).toEqual([{ code: null, signal: "SIGTERM" }]);
			expect(fs.readdirSync(exitMarkerDir).sort()).toEqual(["tmux-counter.txt"]);
		} finally {
			delete process.env.TMUX_FAKE_COUNTER_FILE;
			delete process.env.TMUX_FAKE_FAIL_ON_CALL;
		}
	});

	it("sends Ctrl-C without finalizing exit when terminate is interrupt", () => {
		const exitMarkerDir = fs.mkdtempSync(path.join(fakeRootDir, "tmux-interrupt-"));
		const logPath = path.join(exitMarkerDir, "tmux.log");
		process.env.TMUX_FAKE_LOG_FILE = logPath;
		try {
			const exits: Array<{ code: number | null; signal: string | null }> = [];
			const adapter = new TmuxSubagentProcessAdapter({
				exitMarkerDir,
				pollIntervalMs: 60_000,
			});
			const handle = adapter.launch(makeLaunchSpec(), {
				onExit(exit) {
					exits.push(exit);
				},
			});

			handle.terminate("interrupt");

			expect(exits).toEqual([]);
			expect(fs.readFileSync(logPath, "utf8")).toContain("send-keys -t session:1.1 C-c");
			expect(fs.readdirSync(exitMarkerDir).sort()).toContain("tmux.log");

			handle.terminate("shutdown");
			expect(exits).toEqual([{ code: null, signal: "SIGTERM" }]);
		} finally {
			delete process.env.TMUX_FAKE_LOG_FILE;
		}
	});
});

describe("NodeSidecarSessionAdapter", () => {
	it("does not unlink a socket path it failed to bind and therefore does not own", async () => {
		const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pnx-own-"));
		const socketPath = path.join(runtimeDir, "bridge.sock");
		const owner = net.createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				owner.once("listening", () => resolve());
				owner.once("error", reject);
				owner.listen(socketPath);
			});

			const disconnectReasons: Array<string | undefined> = [];
			const adapter = new NodeSidecarSessionAdapter();
			const handle = adapter.openSession(socketPath, {
				onConnect() {
					return { ok: true, value: undefined };
				},
				onMessage() {
					return { ok: true, value: undefined };
				},
				onDisconnect(reason) {
					disconnectReasons.push(reason);
					return { ok: true, value: undefined };
				},
			});

			await waitFor(() => disconnectReasons.length === 1);
			handle.close();

			expect(disconnectReasons[0]).toContain("EADDRINUSE");
			expect(fs.existsSync(socketPath)).toBe(true);

			const probe = net.createConnection(socketPath);
			await waitForSocketConnect(probe);
			probe.end();
		} finally {
			await new Promise<void>((resolve, reject) => owner.close((error) => (error ? reject(error) : resolve())));
			fs.rmSync(runtimeDir, { recursive: true, force: true });
		}
	});
});

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
