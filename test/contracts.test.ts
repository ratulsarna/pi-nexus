import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
	BOOTSTRAP_CONFIG_ENV_VAR,
	assertRuntimeStateTransition,
	canTransitionRuntimeState,
	createRuntimeLaunchSpec,
	createUserIntervenedMetadata,
	isTerminalRuntimeState,
	shouldEmitUserIntervened,
	validateReportToParentInput,
	validateRuntimeBootstrapConfig,
	validateRuntimeLaunchSpec,
	validateSidecarHandshake,
	validateMonotonicSeqAcceptance,
	validateSidecarProtocolEnvelope,
	validateSubagentRecord,
	type RuntimeBootstrapConfig,
	type RuntimeState,
	type SubagentRecord,
} from "../src/contracts.js";

let originalPath: string | undefined;
let originalHome: string | undefined;
let originalContractEnvMarker: string | undefined;
let fakeBinDir = os.tmpdir();
let fakeRepoDir = os.tmpdir();
let fakeRuntimeDir = os.tmpdir();
let fakeBootstrapExtensionPath = path.join(os.tmpdir(), "subagent-bootstrap.ts");
let fakePiPath = path.join(os.tmpdir(), "pi");
let fakeBootstrapConfigPath = path.join(os.tmpdir(), "bootstrap.json");

function createStaleUnixSocket(socketPath: string): void {
	const result = spawnSync(
		process.execPath,
		[
			"-e",
			`
const net = require("node:net");
const socketPath = process.argv[1];
const server = net.createServer();
server.listen(socketPath, () => {
	process.exit(0);
});
`,
			socketPath,
		],
		{
			stdio: "ignore",
			timeout: 1000,
		},
	);

	if (result.status !== 0) {
		throw new Error(`failed to create stale unix socket at ${socketPath}`);
	}
}

function makeBootstrap(overrides: Partial<RuntimeBootstrapConfig> = {}): RuntimeBootstrapConfig {
	return {
		agentId: "agt_123",
		sessionPath: path.join(fakeRuntimeDir, "session.jsonl"),
		socketPath: path.join(fakeRuntimeDir, "bridge.sock"),
		tmuxMode: "pane",
		tmuxTarget: "main:2.1",
		initialPrompt: "Review the auth flow",
		bootstrapExtensionPath: fakeBootstrapExtensionPath,
		cwd: fakeRepoDir,
		childMode: "interactive-cli",
		...overrides,
	};
}

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
	return {
		id: "agt_123",
		type: "general-purpose",
		description: "Review auth flow",
		state: "starting",
		tmuxMode: "pane",
		tmuxTarget: "main:2.1",
		sessionPath: path.join(fakeRuntimeDir, "session.jsonl"),
		socketPath: path.join(fakeRuntimeDir, "bridge.sock"),
		childMode: "interactive-cli",
		createdAt: "2026-03-10T10:00:00.000Z",
		...overrides,
	};
}

beforeAll(() => {
	originalPath = process.env.PATH;
	originalHome = process.env.HOME;
	originalContractEnvMarker = process.env.PI_SUBAGENTS_TMUX_TEST_MARKER;
	fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-bin-"));
	fakeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-repo-"));
	fakeRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-runtime-"));
	fakeBootstrapExtensionPath = path.join(fakeRepoDir, "subagent-bootstrap.ts");
	fakeBootstrapConfigPath = path.join(fakeRepoDir, "bootstrap.json");
	fakePiPath = path.join(fakeBinDir, "pi");
	fs.writeFileSync(fakePiPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	fs.writeFileSync(fakeBootstrapExtensionPath, "export {};\n");
	fs.writeFileSync(fakeBootstrapConfigPath, `${JSON.stringify(makeBootstrap(), null, 2)}\n`);
	process.env.PATH = [fakeBinDir, originalPath].filter((value): value is string => typeof value === "string").join(path.delimiter);
	process.env.HOME = originalHome ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-home-"));
	process.env.PI_SUBAGENTS_TMUX_TEST_MARKER = "present";
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
	if (originalContractEnvMarker === undefined) {
		delete process.env.PI_SUBAGENTS_TMUX_TEST_MARKER;
	} else {
		process.env.PI_SUBAGENTS_TMUX_TEST_MARKER = originalContractEnvMarker;
	}

	fs.rmSync(fakeBinDir, { recursive: true, force: true });
	fs.rmSync(fakeRepoDir, { recursive: true, force: true });
	fs.rmSync(fakeRuntimeDir, { recursive: true, force: true });
});

describe("validateRuntimeBootstrapConfig", () => {
	it("accepts a valid bootstrap payload", () => {
		const result = validateRuntimeBootstrapConfig(makeBootstrap());
		expect(result.ok).toBe(true);
	});

	it("rejects malformed bootstrap input without throwing", () => {
		expect(validateRuntimeBootstrapConfig(null)).toEqual({
			ok: false,
			error: "bootstrap config must be an object",
		});
		expect(validateRuntimeBootstrapConfig("bad")).toEqual({
			ok: false,
			error: "bootstrap config must be an object",
		});
	});

	it.each([
		["agentId", makeBootstrap({ agentId: "   " })],
		["sessionPath", makeBootstrap({ sessionPath: "" })],
		["socketPath", makeBootstrap({ socketPath: "relative.sock" })],
		["bootstrapExtensionPath", makeBootstrap({ bootstrapExtensionPath: "bootstrap.ts" })],
		["tmuxTarget", makeBootstrap({ tmuxTarget: "" })],
		["initialPrompt", makeBootstrap({ initialPrompt: "   " })],
		["cwd", makeBootstrap({ cwd: "repo" })],
	])("rejects invalid %s", (_field, payload) => {
		const result = validateRuntimeBootstrapConfig(payload);
		expect(result.ok).toBe(false);
	});

	it("rejects an invalid tmux mode", () => {
		const result = validateRuntimeBootstrapConfig({
			...makeBootstrap(),
			tmuxMode: "tab" as RuntimeBootstrapConfig["tmuxMode"],
		});
		expect(result).toEqual({
			ok: false,
			error: 'tmuxMode must be either "pane" or "window"',
		});
	});

	it("rejects bootstrap configs whose cwd does not exist", () => {
		const result = validateRuntimeBootstrapConfig(
			makeBootstrap({ cwd: path.join(fakeRepoDir, "missing-cwd") }),
		);
		expect(result).toEqual({
			ok: false,
			error: "cwd must exist and be a directory",
		});
	});

	it("rejects bootstrap configs whose bootstrap extension path does not exist", () => {
		const result = validateRuntimeBootstrapConfig(
			makeBootstrap({ bootstrapExtensionPath: path.join(fakeRepoDir, "missing-bootstrap.ts") }),
		);
		expect(result).toEqual({
			ok: false,
			error: "bootstrapExtensionPath must exist and be a file",
		});
	});

	it("rejects bootstrap configs whose session path parent directory does not exist", () => {
		const result = validateRuntimeBootstrapConfig(
			makeBootstrap({ sessionPath: path.join(fakeRepoDir, "missing-runtime", "session.jsonl") }),
		);
		expect(result).toEqual({
			ok: false,
			error: "sessionPath parent directory must exist",
		});
	});

	it("rejects bootstrap configs whose socket path parent directory does not exist", () => {
		const result = validateRuntimeBootstrapConfig(
			makeBootstrap({ socketPath: path.join(fakeRepoDir, "missing-runtime", "bridge.sock") }),
		);
		expect(result).toEqual({
			ok: false,
			error: "socketPath parent directory must exist",
		});
	});

	it("rejects bootstrap configs whose session path points to an existing directory", () => {
		const sessionDir = path.join(fakeRuntimeDir, "session-dir");
		fs.mkdirSync(sessionDir);

		const result = validateRuntimeBootstrapConfig(makeBootstrap({ sessionPath: sessionDir }));
		expect(result).toEqual({
			ok: false,
			error: "sessionPath must not be an existing directory",
		});
	});

	it("rejects bootstrap configs whose session path points to an existing non-file path", async () => {
		const sessionSocketPath = path.join(fakeRuntimeDir, "session.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(sessionSocketPath, resolve);
		});

		try {
			const result = validateRuntimeBootstrapConfig(makeBootstrap({ sessionPath: sessionSocketPath }));
			expect(result).toEqual({
				ok: false,
				error: "sessionPath must not be an existing non-file path",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("accepts bootstrap configs whose session path is a symlink to a regular file", () => {
		const realSessionPath = path.join(fakeRuntimeDir, "session-real.jsonl");
		const symlinkSessionPath = path.join(fakeRuntimeDir, "session-link.jsonl");
		fs.writeFileSync(realSessionPath, "{\"type\":\"session\"}\n");
		fs.symlinkSync(realSessionPath, symlinkSessionPath);

		const result = validateRuntimeBootstrapConfig(makeBootstrap({ sessionPath: symlinkSessionPath }));
		expect(result.ok).toBe(true);
	});

	it("rejects bootstrap configs whose socket path points to an existing directory", () => {
		const socketDir = path.join(fakeRuntimeDir, "socket-dir");
		fs.mkdirSync(socketDir);

		const result = validateRuntimeBootstrapConfig(makeBootstrap({ socketPath: socketDir }));
		expect(result).toEqual({
			ok: false,
			error: "socketPath must not be an existing directory",
		});
	});

	it("rejects bootstrap configs whose socket path is already occupied", () => {
		const occupiedSocketPath = path.join(fakeRuntimeDir, "occupied.sock");
		fs.writeFileSync(occupiedSocketPath, "stale socket placeholder\n");

		const result = validateRuntimeBootstrapConfig(makeBootstrap({ socketPath: occupiedSocketPath }));
		expect(result).toEqual({
			ok: false,
			error: "socketPath must not already exist",
		});
	});

	it("accepts bootstrap configs whose socket path is an existing unix socket listener", async () => {
		const listeningSocketPath = path.join(fakeRuntimeDir, "listening.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(listeningSocketPath, resolve);
		});

		try {
			const result = validateRuntimeBootstrapConfig(makeBootstrap({ socketPath: listeningSocketPath }));
			expect(result.ok).toBe(true);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("rejects bootstrap configs whose socket path is a stale unix socket", () => {
		const staleSocketPath = path.join(fakeRuntimeDir, "stale.sock");
		createStaleUnixSocket(staleSocketPath);

		const result = validateRuntimeBootstrapConfig(makeBootstrap({ socketPath: staleSocketPath }));
		expect(result).toEqual({
			ok: false,
			error: "socketPath must not be a stale unix socket",
		});
	});
});

describe("createRuntimeLaunchSpec / validateRuntimeLaunchSpec", () => {
	it("creates a launch spec for stock interactive pi plus bootstrap extension", () => {
		const result = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.agentId).toBe("agt_123");
		expect(result.value.initialPrompt).toBe("Review the auth flow");
		expect(path.isAbsolute(result.value.command)).toBe(true);
		expect(path.basename(result.value.command)).toBe("pi");
		expect(result.value.args).toEqual([
			"--session",
			path.join(fakeRuntimeDir, "session.jsonl"),
			"--extension",
			fakeBootstrapExtensionPath,
		]);
		expect(result.value.env).toEqual({
			...Object.fromEntries(
				Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			),
			[BOOTSTRAP_CONFIG_ENV_VAR]: fakeBootstrapConfigPath,
		});
		expect(result.value.bootstrapExtensionPath).toBe(fakeBootstrapExtensionPath);
	});

	it("keeps dash-prefixed initial prompts in bootstrap config instead of argv", () => {
		const dashPromptBootstrapPath = path.join(fakeRepoDir, "dash-prompt-bootstrap.json");
		fs.writeFileSync(
			dashPromptBootstrapPath,
			`${JSON.stringify(makeBootstrap({ initialPrompt: "--help me debug auth" }), null, 2)}\n`,
		);
		const result = createRuntimeLaunchSpec(
			makeBootstrap({ initialPrompt: "--help me debug auth" }),
			dashPromptBootstrapPath,
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.value.args).toEqual([
			"--session",
			path.join(fakeRuntimeDir, "session.jsonl"),
			"--extension",
			fakeBootstrapExtensionPath,
		]);
		expect(JSON.parse(fs.readFileSync(dashPromptBootstrapPath, "utf8"))).toMatchObject({
			initialPrompt: "--help me debug auth",
		});
		expect(result.value.initialPrompt).toBe("--help me debug auth");
	});

	it("rejects an invalid bootstrap config before building the launch spec", () => {
		const result = createRuntimeLaunchSpec(makeBootstrap({ initialPrompt: "" }), fakeBootstrapConfigPath);
		expect(result.ok).toBe(false);
	});

	it("rejects an invalid bootstrap config path", () => {
		const result = createRuntimeLaunchSpec(makeBootstrap(), "bootstrap.json");
		expect(result).toEqual({
			ok: false,
			error: "bootstrapConfigPath must be an absolute path",
		});
	});

	it("rejects a missing bootstrap config path", () => {
		const result = createRuntimeLaunchSpec(
			makeBootstrap(),
			path.join(fakeRepoDir, "missing-bootstrap.json"),
		);
		expect(result).toEqual({
			ok: false,
			error: "bootstrapConfigPath must exist and be a file",
		});
	});

	it("rejects launch-spec creation when bootstrapConfigPath contents do not match the provided bootstrap config", () => {
		const staleBootstrapPath = path.join(fakeRepoDir, "stale-create-bootstrap.json");
		fs.writeFileSync(
			staleBootstrapPath,
			`${JSON.stringify(makeBootstrap({ agentId: "agt_other" }), null, 2)}\n`,
		);

		const result = createRuntimeLaunchSpec(makeBootstrap(), staleBootstrapPath);
		expect(result).toEqual({
			ok: false,
			error: "bootstrap config agentId must match provided bootstrap config agentId",
		});
	});

	it("fails launch-spec creation when inherited HOME is unusable", () => {
		const originalHome = process.env.HOME;
		delete process.env.HOME;

		try {
			const result = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
			expect(result).toEqual({
				ok: false,
				error: "env.HOME must be a non-empty string",
			});
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	it("fails launch-spec creation when relative pi depends on missing PATH", () => {
		const originalPath = process.env.PATH;
		delete process.env.PATH;

		try {
			const result = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
			expect(result).toEqual({
				ok: false,
				error: "env.PATH must be a non-empty string",
			});
		} finally {
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
		}
	});

	it("validates a good launch spec", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const result = validateRuntimeLaunchSpec(created.value);
		expect(result.ok).toBe(true);
	});

	it("rejects launch specs whose command does not resolve to pi", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const result = validateRuntimeLaunchSpec({ ...created.value, command: "/bin/echo" });
		expect(result).toEqual({
			ok: false,
			error: "command must resolve to pi",
		});
	});

	it("rejects malformed launch-spec input without throwing", () => {
		expect(validateRuntimeLaunchSpec(null)).toEqual({
			ok: false,
			error: "launch spec must be an object",
		});
		expect(validateRuntimeLaunchSpec({})).toEqual({
			ok: false,
			error: "agentId must be a non-empty string",
		});
	});

	it("rejects empty launch args", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const result = validateRuntimeLaunchSpec({ ...created.value, args: [] });
		expect(result).toEqual({
			ok: false,
			error: "args must be: --session <sessionPath> --extension <extensionPath>",
		});
	});

	it("rejects launch specs without the required --extension contract", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const result = validateRuntimeLaunchSpec({
			...created.value,
			args: ["--session", path.join(fakeRuntimeDir, "session.jsonl"), "--"],
		});
		expect(result).toEqual({
			ok: false,
			error: "args must be: --session <sessionPath> --extension <extensionPath>",
		});
	});

	it("rejects launch specs whose extension arg does not match bootstrapExtensionPath", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const result = validateRuntimeLaunchSpec({
			...created.value,
			args: [
				"--session",
				path.join(fakeRuntimeDir, "session.jsonl"),
				"--extension",
				path.join(fakeRepoDir, "other-extension.ts"),
			],
		});
		expect(result).toEqual({
			ok: false,
			error: "args[3] must match bootstrapExtensionPath",
		});
	});

	it("rejects launch specs without a bootstrap config env var", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const result = validateRuntimeLaunchSpec({ ...created.value, env: {} });
		expect(result).toEqual({
			ok: false,
			error: `${BOOTSTRAP_CONFIG_ENV_VAR} must be a non-empty string`,
		});
	});

	it("rejects launch specs that drop HOME from the inherited environment", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const { HOME: _home, ...envWithoutHome } = created.value.env;
		const result = validateRuntimeLaunchSpec({ ...created.value, env: envWithoutHome });
		expect(result).toEqual({
			ok: false,
			error: "env.HOME must be a non-empty string",
		});
	});

	it("accepts persisted launch specs without revalidating against the current parent environment", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const { PI_SUBAGENTS_TMUX_TEST_MARKER: _marker, ...envWithoutMarker } = created.value.env;
		const result = validateRuntimeLaunchSpec({ ...created.value, env: envWithoutMarker });
		expect(result.ok).toBe(true);
	});

	it("rejects non-absolute pi commands that drop PATH from the inherited environment", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const { PATH: _path, ...envWithoutPath } = created.value.env;
		const result = validateRuntimeLaunchSpec({ ...created.value, command: "pi", env: envWithoutPath });
		expect(result).toEqual({
			ok: false,
			error: "command must be an absolute path",
		});
	});

	it("accepts absolute pi command paths when PATH is absent from persisted env", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const { PATH: _path, ...envWithoutPath } = created.value.env;
		const result = validateRuntimeLaunchSpec({
			...created.value,
			command: fakePiPath,
			env: envWithoutPath,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects launch specs when bootstrap config env does not match the recorded path", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const result = validateRuntimeLaunchSpec({
			...created.value,
			env: {
				[BOOTSTRAP_CONFIG_ENV_VAR]: path.join(fakeRepoDir, "other-bootstrap.json"),
			},
		});
		expect(result).toEqual({
			ok: false,
			error: `${BOOTSTRAP_CONFIG_ENV_VAR} must match bootstrapConfigPath`,
		});
	});

	it("rejects launch specs whose command is no longer executable", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const missingPiPath = path.join(fakeRepoDir, "pi");
		const result = validateRuntimeLaunchSpec({
			...created.value,
			command: missingPiPath,
		});
		expect(result).toEqual({
			ok: false,
			error: `command is not executable: ${missingPiPath}`,
		});
	});

	it("accepts persisted launch specs whose command is a different executable named pi", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const otherPiPath = path.join(fakeRepoDir, "pi");
		fs.writeFileSync(otherPiPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const result = validateRuntimeLaunchSpec({
			...created.value,
			command: otherPiPath,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects launch specs whose command path is a directory named pi", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const fakePiDirectory = path.join(fakeRepoDir, "pi-dir");
		fs.mkdirSync(fakePiDirectory);
		const result = validateRuntimeLaunchSpec({
			...created.value,
			command: fakePiDirectory,
		});
		expect(result).toEqual({
			ok: false,
			error: "command must resolve to pi",
		});
	});

	it("resolves a real pi binary instead of a directory named pi in PATH", () => {
		const fakePathDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-path-"));
		const fakePiDirectory = path.join(fakePathDir, "pi");
		fs.mkdirSync(fakePiDirectory);
		const originalPath = process.env.PATH;
		process.env.PATH = [fakePathDir, fakeBinDir, originalPath]
			.filter((value): value is string => typeof value === "string")
			.join(path.delimiter);

		try {
			const result = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.command).toBe(fakePiPath);
		} finally {
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
			fs.rmSync(fakePathDir, { recursive: true, force: true });
		}
	});

	it("resolves relative PATH entries to an absolute pi command path", () => {
		const originalPath = process.env.PATH;
		const relativeBinDir = "relative-bin";
		const relativeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-relative-repo-"));
		const absoluteRelativeBinDir = path.join(relativeRepoDir, relativeBinDir);
		const relativeBootstrapPath = path.join(relativeRepoDir, "bootstrap.json");
		fs.mkdirSync(absoluteRelativeBinDir);
		const relativePiPath = path.join(absoluteRelativeBinDir, "pi");
		fs.writeFileSync(relativePiPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		fs.writeFileSync(
			relativeBootstrapPath,
			`${JSON.stringify(makeBootstrap({ cwd: relativeRepoDir }), null, 2)}\n`,
		);
		process.env.PATH = [relativeBinDir, originalPath]
			.filter((value): value is string => typeof value === "string")
			.join(path.delimiter);

		try {
			const result = createRuntimeLaunchSpec(
				makeBootstrap({ cwd: relativeRepoDir }),
				relativeBootstrapPath,
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(fs.realpathSync.native(result.value.command)).toBe(fs.realpathSync.native(relativePiPath));
			expect(path.isAbsolute(result.value.command)).toBe(true);
		} finally {
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
			fs.rmSync(relativeRepoDir, { recursive: true, force: true });
		}
	});

	it("treats empty PATH entries as the launch cwd when resolving pi", () => {
		const originalPath = process.env.PATH;
		const launchRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-empty-path-repo-"));
		const bootstrapPath = path.join(launchRepoDir, "bootstrap.json");
		const cwdPiPath = path.join(launchRepoDir, "pi");
		fs.writeFileSync(cwdPiPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		fs.writeFileSync(
			bootstrapPath,
			`${JSON.stringify(makeBootstrap({ cwd: launchRepoDir }), null, 2)}\n`,
		);
		process.env.PATH = path.delimiter;

		try {
			const result = createRuntimeLaunchSpec(
				makeBootstrap({ cwd: launchRepoDir }),
				bootstrapPath,
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(fs.realpathSync.native(result.value.command)).toBe(fs.realpathSync.native(cwdPiPath));
			expect(path.isAbsolute(result.value.command)).toBe(true);
		} finally {
			if (originalPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = originalPath;
			}
			fs.rmSync(launchRepoDir, { recursive: true, force: true });
		}
	});

	it("rejects launch specs whose cwd does not exist", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const result = validateRuntimeLaunchSpec({
			...created.value,
			cwd: path.join(fakeRepoDir, "missing-cwd"),
		});
		expect(result).toEqual({
			ok: false,
			error: "cwd must exist and be a directory",
		});
	});

	it("rejects launch specs whose bootstrap extension path does not exist", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const missingExtensionPath = path.join(fakeRepoDir, "missing-bootstrap.ts");
		const result = validateRuntimeLaunchSpec({
			...created.value,
			args: [
				"--session",
				path.join(fakeRuntimeDir, "session.jsonl"),
				"--extension",
				missingExtensionPath,
			],
			bootstrapExtensionPath: missingExtensionPath,
		});
		expect(result).toEqual({
			ok: false,
			error: "bootstrapExtensionPath must exist and be a file",
		});
	});

	it("rejects launch specs whose session path parent directory no longer exists", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const missingSessionPath = path.join(fakeRepoDir, "missing-runtime", "session.jsonl");
		const result = validateRuntimeLaunchSpec({
			...created.value,
			args: [
				"--session",
				missingSessionPath,
				"--extension",
				fakeBootstrapExtensionPath,
			],
			sessionPath: missingSessionPath,
		});
		expect(result).toEqual({
			ok: false,
			error: "sessionPath parent directory must exist",
		});
	});

	it("rejects launch specs whose socket path parent directory no longer exists", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const missingSocketPath = path.join(fakeRepoDir, "missing-runtime", "bridge.sock");
		const result = validateRuntimeLaunchSpec({
			...created.value,
			socketPath: missingSocketPath,
		});
		expect(result).toEqual({
			ok: false,
			error: "socketPath parent directory must exist",
		});
	});

	it("rejects launch specs whose session path points to an existing directory", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const sessionDir = path.join(fakeRuntimeDir, "launch-session-dir");
		fs.mkdirSync(sessionDir);
		const result = validateRuntimeLaunchSpec({
			...created.value,
			args: [
				"--session",
				sessionDir,
				"--extension",
				fakeBootstrapExtensionPath,
			],
			sessionPath: sessionDir,
		});
		expect(result).toEqual({
			ok: false,
			error: "sessionPath must not be an existing directory",
		});
	});

	it("rejects launch specs whose session path points to an existing non-file path", async () => {
		const sessionSocketPath = path.join(fakeRuntimeDir, "launch-session.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(sessionSocketPath, resolve);
		});

		try {
			const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
			if (!created.ok) throw new Error(created.error);

			const result = validateRuntimeLaunchSpec({
				...created.value,
				args: [
					"--session",
					sessionSocketPath,
					"--extension",
					fakeBootstrapExtensionPath,
				],
				sessionPath: sessionSocketPath,
			});
			expect(result).toEqual({
				ok: false,
				error: "sessionPath must not be an existing non-file path",
			});
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("accepts launch specs whose session path is a symlink to a regular file", () => {
		const realSessionPath = path.join(fakeRuntimeDir, "launch-session-real.jsonl");
		const symlinkSessionPath = path.join(fakeRuntimeDir, "launch-session-link.jsonl");
		fs.writeFileSync(realSessionPath, "{\"type\":\"session\"}\n");
		fs.symlinkSync(realSessionPath, symlinkSessionPath);

		const bootstrapPath = path.join(fakeRepoDir, "launch-session-symlink-bootstrap.json");
		fs.writeFileSync(
			bootstrapPath,
			`${JSON.stringify(makeBootstrap({ sessionPath: symlinkSessionPath }), null, 2)}\n`,
		);
		const created = createRuntimeLaunchSpec(
			makeBootstrap({ sessionPath: symlinkSessionPath }),
			bootstrapPath,
		);
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const result = validateRuntimeLaunchSpec(created.value);
		expect(result.ok).toBe(true);
	});

	it("rejects launch specs whose socket path points to an existing directory", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const socketDir = path.join(fakeRuntimeDir, "launch-socket-dir");
		fs.mkdirSync(socketDir);
		const result = validateRuntimeLaunchSpec({
			...created.value,
			socketPath: socketDir,
		});
		expect(result).toEqual({
			ok: false,
			error: "socketPath must not be an existing directory",
		});
	});

	it("rejects launch specs whose socket path is already occupied", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const occupiedSocketPath = path.join(fakeRuntimeDir, "launch-occupied.sock");
		fs.writeFileSync(occupiedSocketPath, "stale socket placeholder\n");
		const result = validateRuntimeLaunchSpec({
			...created.value,
			socketPath: occupiedSocketPath,
		});
		expect(result).toEqual({
			ok: false,
			error: "socketPath must not already exist",
		});
	});

	it("accepts launch specs whose socket path is an existing unix socket listener", async () => {
		const listeningSocketPath = path.join(fakeRuntimeDir, "launch-listening.sock");
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(listeningSocketPath, resolve);
		});

		try {
			const bootstrapPath = path.join(fakeRepoDir, "listening-bootstrap.json");
			fs.writeFileSync(
				bootstrapPath,
				`${JSON.stringify(makeBootstrap({ socketPath: listeningSocketPath }), null, 2)}\n`,
			);
			const created = createRuntimeLaunchSpec(
				makeBootstrap({ socketPath: listeningSocketPath }),
				bootstrapPath,
			);
			expect(created.ok).toBe(true);
			if (!created.ok) return;

			const result = validateRuntimeLaunchSpec(created.value);
			expect(result.ok).toBe(true);
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it("rejects launch specs whose socket path is a stale unix socket", () => {
		const staleSocketPath = path.join(fakeRuntimeDir, "launch-stale.sock");
		createStaleUnixSocket(staleSocketPath);

		const bootstrapPath = path.join(fakeRepoDir, "stale-socket-bootstrap.json");
		fs.writeFileSync(
			bootstrapPath,
			`${JSON.stringify(makeBootstrap({ socketPath: staleSocketPath }), null, 2)}\n`,
		);
		const created = createRuntimeLaunchSpec(makeBootstrap({ socketPath: staleSocketPath }), bootstrapPath);
		expect(created).toEqual({
			ok: false,
			error: "socketPath must not be a stale unix socket",
		});
	});

	it("rejects persisted launch specs whose socket path is a stale unix socket", () => {
		const staleSocketPath = path.join(fakeRuntimeDir, "persisted-stale.sock");
		createStaleUnixSocket(staleSocketPath);
		const bootstrapPath = path.join(fakeRepoDir, "persisted-stale-bootstrap.json");
		fs.writeFileSync(
			bootstrapPath,
			`${JSON.stringify(makeBootstrap({ socketPath: staleSocketPath }), null, 2)}\n`,
		);
		const created = createRuntimeLaunchSpec(
			makeBootstrap(),
			fakeBootstrapConfigPath,
		);
		if (!created.ok) throw new Error(created.error);

		const result = validateRuntimeLaunchSpec({
			...created.value,
			socketPath: staleSocketPath,
			bootstrapConfigPath: bootstrapPath,
			env: {
				...created.value.env,
				[BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapPath,
			},
		});
		expect(result).toEqual({
			ok: false,
			error: "socketPath must not be a stale unix socket",
		});
	});

	it("rejects launch specs whose bootstrap config path no longer exists", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const missingBootstrapConfigPath = path.join(fakeRepoDir, "missing-bootstrap.json");
		const result = validateRuntimeLaunchSpec({
			...created.value,
			env: {
				...created.value.env,
				[BOOTSTRAP_CONFIG_ENV_VAR]: missingBootstrapConfigPath,
			},
			bootstrapConfigPath: missingBootstrapConfigPath,
		});
		expect(result).toEqual({
			ok: false,
			error: "bootstrapConfigPath must exist and be a file",
		});
	});

	it("rejects launch specs whose bootstrap config file is not valid JSON", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const badBootstrapPath = path.join(fakeRepoDir, "bad-bootstrap.json");
		fs.writeFileSync(badBootstrapPath, "{not-json\n");
		const result = validateRuntimeLaunchSpec({
			...created.value,
			env: {
				...created.value.env,
				[BOOTSTRAP_CONFIG_ENV_VAR]: badBootstrapPath,
			},
			bootstrapConfigPath: badBootstrapPath,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("bootstrapConfigPath must contain valid JSON");
	});

	it("rejects launch specs whose bootstrap config contents do not match the launch spec", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const staleBootstrapPath = path.join(fakeRepoDir, "stale-bootstrap.json");
		fs.writeFileSync(
			staleBootstrapPath,
			`${JSON.stringify(makeBootstrap({ tmuxTarget: "other:9.9" }), null, 2)}\n`,
		);
		const result = validateRuntimeLaunchSpec({
			...created.value,
			env: {
				...created.value.env,
				[BOOTSTRAP_CONFIG_ENV_VAR]: staleBootstrapPath,
			},
			bootstrapConfigPath: staleBootstrapPath,
		});
		expect(result).toEqual({
			ok: false,
			error: "bootstrap config tmuxTarget must match launch spec tmuxTarget",
		});
	});

	it("rejects launch specs whose bootstrap config initial prompt drifts from the persisted launch spec", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const driftedBootstrapPath = path.join(fakeRepoDir, "drifted-prompt-bootstrap.json");
		fs.writeFileSync(
			driftedBootstrapPath,
			`${JSON.stringify(makeBootstrap({ initialPrompt: "Different task" }), null, 2)}\n`,
		);
		const result = validateRuntimeLaunchSpec({
			...created.value,
			bootstrapConfigPath: driftedBootstrapPath,
			env: {
				...created.value.env,
				[BOOTSTRAP_CONFIG_ENV_VAR]: driftedBootstrapPath,
			},
		});
		expect(result).toEqual({
			ok: false,
			error: "bootstrap config initialPrompt must match launch spec initialPrompt",
		});
	});

	it("rejects launch specs that reuse one path for multiple runtime roles", () => {
		const collidedPath = path.join(fakeRuntimeDir, "collided.jsonl");
		const bootstrapPath = path.join(fakeRepoDir, "collided-bootstrap.json");
		fs.writeFileSync(
			bootstrapPath,
			`${JSON.stringify(makeBootstrap({ sessionPath: collidedPath, socketPath: collidedPath }), null, 2)}\n`,
		);

		const result = createRuntimeLaunchSpec(
			makeBootstrap({ sessionPath: collidedPath, socketPath: collidedPath }),
			bootstrapPath,
		);
		expect(result).toEqual({
			ok: false,
			error: "sessionPath must not equal socketPath",
		});
	});

	it("rejects launch specs whose runtime role paths only differ by alias segments", () => {
		const aliasedSessionPath = path.join(fakeRuntimeDir, "nested", "..", "session.jsonl");
		const result = createRuntimeLaunchSpec(
			makeBootstrap({
				sessionPath: aliasedSessionPath,
				socketPath: path.join(fakeRuntimeDir, "session.jsonl"),
			}),
			fakeBootstrapConfigPath,
		);
		expect(result).toEqual({
			ok: false,
			error: "sessionPath must not equal socketPath",
		});
	});

	it("rejects launch specs whose runtime role paths collide through symlinked parents", () => {
		const symlinkRoot = path.join(fakeRepoDir, "runtime-link");
		fs.symlinkSync(fakeRuntimeDir, symlinkRoot);
		const bootstrapPath = path.join(fakeRepoDir, "symlink-collision-bootstrap.json");
		const symlinkedSessionPath = path.join(symlinkRoot, "session.jsonl");
		const realSessionPath = path.join(fakeRuntimeDir, "session.jsonl");
		fs.writeFileSync(
			bootstrapPath,
			`${JSON.stringify(makeBootstrap({ sessionPath: symlinkedSessionPath, socketPath: realSessionPath }), null, 2)}\n`,
		);

		const result = createRuntimeLaunchSpec(
			makeBootstrap({ sessionPath: symlinkedSessionPath, socketPath: realSessionPath }),
			bootstrapPath,
		);
		expect(result).toEqual({
			ok: false,
			error: "sessionPath must not equal socketPath",
		});
	});

	it("rejects launch specs with null bytes in env keys or values", () => {
		const created = createRuntimeLaunchSpec(makeBootstrap(), fakeBootstrapConfigPath);
		if (!created.ok) throw new Error(created.error);

		const result = validateRuntimeLaunchSpec({
			...created.value,
			env: {
				...created.value.env,
				BAD: "value\0oops",
			},
		});
		expect(result).toEqual({
			ok: false,
			error: "env must be a string-to-string map",
		});
	});
});

describe("runtime state transitions", () => {
	it.each([
		["starting", "connecting"],
		["connecting", "ready"],
		["ready", "running"],
		["running", "waiting"],
		["waiting", "running"],
		["running", "completed"],
		["ready", "degraded"],
		["degraded", "failed"],
		["running", "stopped"],
	])("allows %s -> %s", (from, to) => {
		expect(canTransitionRuntimeState(from as RuntimeState, to as RuntimeState)).toBe(true);
		expect(assertRuntimeStateTransition(from as RuntimeState, to as RuntimeState)).toEqual({
			ok: true,
			value: to,
		});
	});

	it.each([
		["starting", "ready"],
		["connecting", "running"],
		["completed", "running"],
		["failed", "ready"],
		["stopped", "completed"],
		["degraded", "running"],
		["degraded", "waiting"],
		["degraded", "completed"],
	])("rejects %s -> %s", (from, to) => {
		expect(canTransitionRuntimeState(from as RuntimeState, to as RuntimeState)).toBe(false);
		expect(assertRuntimeStateTransition(from as RuntimeState, to as RuntimeState)).toEqual({
			ok: false,
			error: `invalid runtime state transition: ${from} -> ${to}`,
		});
	});

	it("marks only completed, failed, and stopped as terminal", () => {
		expect(isTerminalRuntimeState("completed")).toBe(true);
		expect(isTerminalRuntimeState("failed")).toBe(true);
		expect(isTerminalRuntimeState("stopped")).toBe(true);
		expect(isTerminalRuntimeState("degraded")).toBe(false);
		expect(isTerminalRuntimeState("running")).toBe(false);
	});
});

describe("validateReportToParentInput", () => {
	it("rejects malformed report payloads without throwing", () => {
		expect(validateReportToParentInput(null)).toEqual({
			ok: false,
			error: "report must be an object",
		});
	});

	it.each(["progress", "final_result", "needs_input"] as const)("accepts %s with non-empty summary and nullish data", (kind) => {
		const result = validateReportToParentInput({ kind, summary: "  useful update  " });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.summary).toBe("useful update");
		expect(result.value.data).toBeNull();
	});

	it("accepts explicit null data", () => {
		const result = validateReportToParentInput({ kind: "progress", summary: "update", data: null });
		expect(result.ok).toBe(true);
	});

	it("normalizes explicit undefined data to null", () => {
		const result = validateReportToParentInput({
			kind: "progress",
			summary: "update",
			data: undefined,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.data).toBeNull();
	});

	it("rejects blank summaries", () => {
		const result = validateReportToParentInput({ kind: "progress", summary: "   " });
		expect(result).toEqual({
			ok: false,
			error: "summary must be a non-empty string",
		});
	});

	it("rejects invalid report kinds", () => {
		const result = validateReportToParentInput({
			kind: "chat" as "progress",
			summary: "update",
		});
		expect(result).toEqual({
			ok: false,
			error: "kind must be one of: progress, final_result, needs_input",
		});
	});

	it.each(["completed", "failed", "stopped"] as const)("rejects reports after terminal state %s", (state) => {
		const result = validateReportToParentInput({ kind: "progress", summary: "update" }, state);
		expect(result).toEqual({
			ok: false,
			error: `cannot accept progress report while state is ${state}`,
		});
	});

	it.each(["starting", "connecting", "degraded"] as const)(
		"rejects reports while state is %s",
		(state) => {
			const result = validateReportToParentInput({ kind: "progress", summary: "update" }, state);
			expect(result).toEqual({
				ok: false,
				error: `cannot accept progress report while state is ${state}`,
			});
		},
	);

	it("rejects a duplicate final_result", () => {
		const result = validateReportToParentInput(
			{ kind: "final_result", summary: "done" },
			"running",
			true,
		);
		expect(result).toEqual({
			ok: false,
			error: "cannot accept final_result report after final_result has been recorded",
		});
	});

	it.each(["progress", "needs_input"] as const)("rejects %s after final_result has been recorded", (kind) => {
		const result = validateReportToParentInput(
			{ kind, summary: "late message" },
			"running",
			true,
		);
		expect(result).toEqual({
			ok: false,
			error: `cannot accept ${kind} report after final_result has been recorded`,
		});
	});
});

describe("sidecar protocol envelope", () => {
	function makeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			version: 1,
			agentId: "agt_123",
			type: "progress",
			seq: 12,
			time: "2026-03-10T10:00:00.000Z",
			payload: {
				summary: "Mapped auth flow",
				data: { files: 2 },
			},
			...overrides,
		};
	}

	it("accepts all supported sidecar message kinds", () => {
		const validCases: ReadonlyArray<[type: string, payload: Record<string, unknown>]> = [
			[
				"hello",
				{
					sessionPath: path.join(fakeRuntimeDir, "session.jsonl"),
					tmuxTarget: "main:2.1",
					mode: "pane",
				},
			],
			[
				"ready",
				{
					pid: 12345,
					sessionPath: path.join(fakeRuntimeDir, "session.jsonl"),
					tmuxTarget: "main:2.1",
				},
			],
			[
				"progress",
				{
					summary: "Working",
					data: { files: ["/repo/src/auth.ts"] },
				},
			],
			[
				"final_result",
				{
					summary: "Done",
					data: { findings: 2 },
				},
			],
			[
				"needs_input",
				{
					question: "Proceed with migration?",
					kind: "decision",
				},
			],
			[
				"user_intervened",
				{
					source: "tmux",
					mode: "direct-chat",
				},
			],
			[
				"state",
				{
					status: "running",
				},
			],
			[
				"error",
				{
					message: "bridge disconnected",
					fatal: true,
				},
			],
			["ping", {}],
			["pong", {}],
		];

		for (const [type, payload] of validCases) {
			const result = validateSidecarProtocolEnvelope(
				makeEnvelope({
					type,
					payload,
				}),
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.value.type).toBe(type);
		}
	});

	it("normalizes trim-sensitive text fields", () => {
		const result = validateSidecarProtocolEnvelope(
			makeEnvelope({
				agentId: "  agt_123  ",
				type: "progress",
				payload: {
					summary: "  mapped auth flow  ",
					data: undefined,
				},
			}),
		);

		expect(result).toEqual({
			ok: true,
			value: {
				version: 1,
				agentId: "agt_123",
				type: "progress",
				seq: 12,
				time: "2026-03-10T10:00:00.000Z",
				payload: {
					summary: "mapped auth flow",
					data: null,
				},
			},
		});
	});

	it("rejects malformed envelopes with deterministic errors", () => {
		expect(validateSidecarProtocolEnvelope(null)).toEqual({
			ok: false,
			error: "sidecar envelope must be an object",
		});

		expect(
			validateSidecarProtocolEnvelope(
				makeEnvelope({
					version: 2,
				}),
			),
		).toEqual({
			ok: false,
			error: "sidecar envelope version must be 1",
		});

		expect(
			validateSidecarProtocolEnvelope(
				makeEnvelope({
					type: "steer",
				}),
			),
		).toEqual({
			ok: false,
			error: "sidecar envelope type must be one of: hello, ready, progress, final_result, needs_input, user_intervened, state, error, ping, pong",
		});

		expect(
			validateSidecarProtocolEnvelope(
				makeEnvelope({
					seq: -1,
				}),
			),
		).toEqual({
			ok: false,
			error: "sidecar envelope seq must be a non-negative safe integer",
		});

		expect(
			validateSidecarProtocolEnvelope(
				makeEnvelope({
					time: "not-a-date",
				}),
			),
		).toEqual({
			ok: false,
			error: "sidecar envelope time must be an ISO timestamp",
		});

		const envelopeWithoutPayload = makeEnvelope();
		delete (envelopeWithoutPayload as { payload?: unknown }).payload;

		expect(validateSidecarProtocolEnvelope(envelopeWithoutPayload)).toEqual({
			ok: false,
			error: "sidecar envelope payload is required",
		});
	});

	it.each([
		[
			"hello",
			makeEnvelope({
				type: "hello",
				payload: {
					sessionPath: "session.jsonl",
					tmuxTarget: "main:2.1",
					mode: "pane",
				},
			}),
			"hello.payload.sessionPath must be an absolute path",
		],
		[
			"ready",
			makeEnvelope({
				type: "ready",
				payload: {
					pid: 0,
					sessionPath: path.join(fakeRuntimeDir, "session.jsonl"),
					tmuxTarget: "main:2.1",
				},
			}),
			"ready.payload.pid must be a positive safe integer",
		],
		[
			"progress",
			makeEnvelope({
				type: "progress",
				payload: {
					summary: "  ",
				},
			}),
			"progress.payload.summary must be a non-empty string",
		],
		[
			"final_result",
			makeEnvelope({
				type: "final_result",
				payload: {
					summary: "",
				},
			}),
			"final_result.payload.summary must be a non-empty string",
		],
		[
			"needs_input",
			makeEnvelope({
				type: "needs_input",
				payload: {
					question: "",
					kind: "decision",
				},
			}),
			"needs_input.payload.question must be a non-empty string",
		],
		[
			"user_intervened",
			makeEnvelope({
				type: "user_intervened",
				payload: {
					source: "tmux",
					mode: "broadcast",
				},
			}),
			"user_intervened.payload.mode must be direct-chat",
		],
		[
			"state",
			makeEnvelope({
				type: "state",
				payload: {
					status: "ready",
				},
			}),
			"state.payload.status must be one of: starting, running, waiting, completed, failed, stopped",
		],
		[
			"error",
			makeEnvelope({
				type: "error",
				payload: {
					message: "fatal",
					fatal: "yes",
				},
			}),
			"error.payload.fatal must be a boolean",
		],
		[
			"ping",
			makeEnvelope({
				type: "ping",
				payload: {
					extra: true,
				},
			}),
			"ping.payload must be an empty object",
		],
		[
			"pong",
			makeEnvelope({
				type: "pong",
				payload: {
					extra: true,
				},
			}),
			"pong.payload must be an empty object",
		],
	])("rejects invalid %s payloads", (_type, envelope, expectedError) => {
		expect(validateSidecarProtocolEnvelope(envelope)).toEqual({
			ok: false,
			error: expectedError,
		});
	});
});

describe("sidecar handshake validation", () => {
	const expectedIdentity = {
		agentId: "agt_123",
		sessionPath: path.join(fakeRuntimeDir, "session.jsonl"),
	};

	function makeHelloEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			version: 1,
			agentId: expectedIdentity.agentId,
			type: "hello",
			seq: 1,
			time: "2026-03-10T10:00:00.000Z",
			payload: {
				sessionPath: expectedIdentity.sessionPath,
				tmuxTarget: "main:2.1",
				mode: "pane",
			},
			...overrides,
		};
	}

	function makeReadyEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			version: 1,
			agentId: expectedIdentity.agentId,
			type: "ready",
			seq: 2,
			time: "2026-03-10T10:00:01.000Z",
			payload: {
				pid: 12345,
				sessionPath: expectedIdentity.sessionPath,
				tmuxTarget: "main:2.1",
			},
			...overrides,
		};
	}

	it("accepts a hello -> ready handshake with matching identity", () => {
		const result = validateSidecarHandshake(
			makeHelloEnvelope({
				agentId: " agt_123 ",
			}),
			makeReadyEnvelope(),
			{
				agentId: "  agt_123 ",
				sessionPath: expectedIdentity.sessionPath,
			},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.hello.type).toBe("hello");
		expect(result.value.ready.type).toBe("ready");
		expect(result.value.hello.agentId).toBe(expectedIdentity.agentId);
		expect(result.value.ready.agentId).toBe(expectedIdentity.agentId);
		expect(result.value.hello.payload.sessionPath).toBe(expectedIdentity.sessionPath);
		expect(result.value.ready.payload.sessionPath).toBe(expectedIdentity.sessionPath);
	});

	it("rejects handshake identities that are malformed", () => {
		expect(validateSidecarHandshake(makeHelloEnvelope(), makeReadyEnvelope(), null)).toEqual({
			ok: false,
			error: "handshake identity must be an object",
		});
	});

	it("rejects handshakes that do not begin with hello", () => {
		expect(validateSidecarHandshake(makeReadyEnvelope(), makeReadyEnvelope(), expectedIdentity)).toEqual({
			ok: false,
			error: "handshake first message must be hello",
		});
	});

	it("rejects handshakes whose second message is not ready", () => {
		expect(validateSidecarHandshake(makeHelloEnvelope(), makeHelloEnvelope(), expectedIdentity)).toEqual({
			ok: false,
			error: "handshake second message must be ready",
		});
	});

	it.each([
		[
			"hello agentId mismatch",
			makeHelloEnvelope({ agentId: "agt_other" }),
			makeReadyEnvelope(),
			"hello agentId must match handshake agentId",
		],
		[
			"ready sessionPath mismatch",
			makeHelloEnvelope(),
			makeReadyEnvelope({
				payload: {
					pid: 12345,
					sessionPath: path.join(fakeRuntimeDir, "other-session.jsonl"),
					tmuxTarget: "main:2.1",
				},
			}),
			"ready sessionPath must match handshake sessionPath",
		],
		[
			"malformed hello payload",
			makeHelloEnvelope({
				payload: {
					sessionPath: "session.jsonl",
					tmuxTarget: "main:2.1",
					mode: "pane",
				},
			}),
			makeReadyEnvelope(),
			"hello.payload.sessionPath must be an absolute path",
		],
		[
			"malformed ready payload",
			makeHelloEnvelope(),
			makeReadyEnvelope({
				payload: {
					pid: 0,
					sessionPath: expectedIdentity.sessionPath,
					tmuxTarget: "main:2.1",
				},
			}),
			"ready.payload.pid must be a positive safe integer",
		],
	])("rejects %s", (_scenario, helloEnvelope, readyEnvelope, expectedError) => {
		expect(validateSidecarHandshake(helloEnvelope, readyEnvelope, expectedIdentity)).toEqual({
			ok: false,
			error: expectedError,
		});
	});
});

describe("delivery ordering seq acceptance", () => {
	it.each([
		["negative", -1],
		["fractional", 3.14],
		["infinite", Number.POSITIVE_INFINITY],
		["string", "12"],
		["null", null],
	])("rejects malformed %s seq values", (_scenario, seq) => {
		expect(validateMonotonicSeqAcceptance(seq)).toEqual({
			ok: false,
			error: "seq must be a non-negative safe integer",
		});
	});

	it("rejects malformed lastAcceptedSeq values", () => {
		expect(validateMonotonicSeqAcceptance(3, "2")).toEqual({
			ok: false,
			error: "lastAcceptedSeq must be a non-negative safe integer",
		});
	});

	it("accepts first delivery when no lastAcceptedSeq is recorded", () => {
		expect(validateMonotonicSeqAcceptance(0)).toEqual({
			ok: true,
			value: 0,
		});
	});

	it("rejects duplicate seq values", () => {
		expect(validateMonotonicSeqAcceptance(12, 12)).toEqual({
			ok: false,
			error: "seq must be greater than lastAcceptedSeq (duplicate seq)",
		});
	});

	it.each([
		["stale", 11, 12],
		["out-of-order", 7, 12],
	])("rejects %s seq values", (_scenario, seq, lastAcceptedSeq) => {
		expect(validateMonotonicSeqAcceptance(seq, lastAcceptedSeq)).toEqual({
			ok: false,
			error: "seq must be greater than lastAcceptedSeq (stale or out-of-order seq)",
		});
	});

	it.each([
		[13, 12],
		[42, 12],
	])("accepts increasing seq values (%d after %d)", (seq, lastAcceptedSeq) => {
		expect(validateMonotonicSeqAcceptance(seq, lastAcceptedSeq)).toEqual({
			ok: true,
			value: seq,
		});
	});
});

describe("user intervention classification", () => {
	it("emits user_intervened only for submitted interactive user prompts", () => {
		expect(shouldEmitUserIntervened({ origin: "interactive-user", submitted: true })).toBe(true);
	});

	it.each([
		{ origin: "interactive-user", submitted: false },
		{ origin: "parent-steer", submitted: true },
		{ origin: "parent-follow_up", submitted: true },
		{ origin: "extension", submitted: true },
		{ origin: "system", submitted: true },
	] as const)("does not emit for %o", (event) => {
		expect(shouldEmitUserIntervened(event)).toBe(false);
	});

	it("creates metadata-only user intervention payloads", () => {
		const result = createUserIntervenedMetadata("2026-03-10T10:00:00.000Z");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({
			source: "tmux",
			mode: "direct-chat",
			inputSource: "interactive-user",
			recordedAt: "2026-03-10T10:00:00.000Z",
		});
	});

	it("rejects invalid metadata timestamps", () => {
		const result = createUserIntervenedMetadata("not-a-date");
		expect(result).toEqual({
			ok: false,
			error: "recordedAt must be an ISO timestamp",
		});
	});

	it("rejects calendar-invalid ISO timestamps without throwing", () => {
		expect(createUserIntervenedMetadata("2026-13-10T10:00:00.000Z")).toEqual({
			ok: false,
			error: "recordedAt must be an ISO timestamp",
		});
	});
});

describe("validateSubagentRecord", () => {
	it("rejects malformed record input without throwing", () => {
		expect(validateSubagentRecord(null)).toEqual({
			ok: false,
			error: "subagent record must be an object",
		});
	});

	it("accepts a minimal valid record", () => {
		const result = validateSubagentRecord(makeRecord());
		expect(result.ok).toBe(true);
	});

	it("rejects falsy optional timestamp fields when they are present", () => {
		expect(validateSubagentRecord(makeRecord({ startedAt: "" }))).toEqual({
			ok: false,
			error: "startedAt must be an ISO timestamp",
		});
		expect(validateSubagentRecord(makeRecord({ stoppedAt: "" }))).toEqual({
			ok: false,
			error: "stoppedAt must be an ISO timestamp",
		});
		expect(validateSubagentRecord(makeRecord({ connectedAt: null as unknown as string }))).toEqual({
			ok: false,
			error: "connectedAt must be an ISO timestamp",
		});
	});

	it("rejects falsy optional object fields when they are present", () => {
		expect(validateSubagentRecord(makeRecord({ userIntervened: null as unknown as SubagentRecord["userIntervened"] }))).toEqual({
			ok: false,
			error: "userIntervened must be an object",
		});
		expect(validateSubagentRecord(makeRecord({ lastProgressReport: null as unknown as SubagentRecord["lastProgressReport"] }))).toEqual({
			ok: false,
			error: "lastProgressReport must be an object",
		});
	});

	it("accepts a completed record only when finalResult exists", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "completed",
				connectedAt: "2026-03-10T10:01:00.000Z",
				completedAt: "2026-03-10T10:05:00.000Z",
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "2026-03-10T10:05:00.000Z",
				},
			}),
		);
		expect(result.ok).toBe(true);
	});

	it("accepts a waiting record with a persisted needs_input request", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "waiting",
				connectedAt: "2026-03-10T10:01:00.000Z",
				pendingInputRequest: {
					kind: "needs_input",
					summary: "Need approval to proceed",
					data: { question: "Continue?" },
					reportedAt: "2026-03-10T10:02:00.000Z",
				},
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.pendingInputRequest).toEqual({
			kind: "needs_input",
			summary: "Need approval to proceed",
			data: { question: "Continue?" },
			reportedAt: "2026-03-10T10:02:00.000Z",
		});
	});

	it("rejects finalResult when the record is not completed", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "running",
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "2026-03-10T10:05:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "finalResult may only be present when state is completed",
		});
	});

	it("rejects a completed record without finalResult", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "completed",
				connectedAt: "2026-03-10T10:01:00.000Z",
				completedAt: "2026-03-10T10:05:00.000Z",
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "completed records must include finalResult",
		});
	});

	it("rejects completedAt on non-completed records", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "running",
				completedAt: "2026-03-10T10:05:00.000Z",
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "completedAt may only be present when state is completed",
		});
	});

	it.each(["ready", "running", "waiting", "completed", "degraded"] as const)(
		"rejects %s records without connectedAt",
		(state) => {
			const base =
				state === "completed"
					? {
							finalResult: {
								kind: "final_result" as const,
								summary: "done",
								data: null,
								reportedAt: "2026-03-10T10:05:00.000Z",
							},
							completedAt: "2026-03-10T10:05:00.000Z",
						}
					: state === "degraded"
						? {
								degradedAt: "2026-03-10T10:05:00.000Z",
							}
						: {};

			const result = validateSubagentRecord(
				makeRecord({
					state,
					...base,
				}),
			);
			expect(result).toEqual({
				ok: false,
				error: `${state} records must include connectedAt`,
			});
		},
	);

	it("rejects startedAt before createdAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				startedAt: "2026-03-10T09:59:59.000Z",
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "startedAt must be on or after createdAt",
		});
	});

	it("rejects connectedAt before startedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "running",
				startedAt: "2026-03-10T10:01:00.000Z",
				connectedAt: "2026-03-10T10:00:30.000Z",
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "connectedAt must be on or after startedAt",
		});
	});

	it("rejects completedAt before connectedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "completed",
				startedAt: "2026-03-10T10:01:00.000Z",
				connectedAt: "2026-03-10T10:02:00.000Z",
				completedAt: "2026-03-10T10:01:30.000Z",
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "2026-03-10T10:01:30.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "completedAt must be on or after connectedAt",
		});
	});

	it("rejects a degraded record without degradedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "degraded",
				connectedAt: "2026-03-10T10:01:00.000Z",
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "degraded records must include degradedAt",
		});
	});

	it("rejects unknown runtime states from untyped sources", () => {
		const result = validateSubagentRecord(makeRecord({ state: "paused" as RuntimeState }));
		expect(result).toEqual({
			ok: false,
			error: "state must be one of: starting, connecting, ready, running, waiting, completed, failed, stopped, degraded",
		});
	});

	it("rejects finalResult with the wrong kind", () => {
		const result = validateSubagentRecord(
			makeRecord({
				finalResult: {
					kind: "progress",
					summary: "wrong",
					data: null,
					reportedAt: "2026-03-10T10:05:00.000Z",
				} as SubagentRecord["finalResult"],
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "finalResult.kind must be final_result",
		});
	});

	it("rejects finalResult with a blank summary", () => {
		const result = validateSubagentRecord(
			makeRecord({
				finalResult: {
					kind: "final_result",
					summary: "   ",
					data: null,
					reportedAt: "2026-03-10T10:05:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "finalResult.summary must be a non-empty string",
		});
	});

	it("rejects finalResult with a bad reportedAt timestamp", () => {
		const result = validateSubagentRecord(
			makeRecord({
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "not-a-date",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "finalResult.reportedAt must be an ISO timestamp",
		});
	});

	it("rejects invalid lastProgressReport payloads", () => {
		const result = validateSubagentRecord(
			makeRecord({
				lastProgressReport: {
					kind: "progress",
					summary: "",
					data: null,
					reportedAt: "2026-03-10T10:05:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "lastProgressReport.summary must be a non-empty string",
		});
	});

	it("rejects pendingInputRequest with the wrong kind", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "waiting",
				connectedAt: "2026-03-10T10:01:00.000Z",
				pendingInputRequest: {
					kind: "progress",
					summary: "wrong",
					data: null,
					reportedAt: "2026-03-10T10:02:00.000Z",
				} as SubagentRecord["pendingInputRequest"],
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "pendingInputRequest.kind must be needs_input",
		});
	});

	it("rejects lastProgressReport with a non-progress kind", () => {
		const result = validateSubagentRecord(
			makeRecord({
				lastProgressReport: {
					kind: "needs_input",
					summary: "waiting on decision",
					data: null,
					reportedAt: "2026-03-10T10:05:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "lastProgressReport.kind must be progress",
		});
	});

	it("rejects malformed userIntervened metadata", () => {
		const result = validateSubagentRecord(
			makeRecord({
				userIntervened: {
					source: "tmux",
					mode: "direct-chat",
					inputSource: "interactive-user",
					recordedAt: "March 10, 2026",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "userIntervened.recordedAt must be an ISO timestamp",
		});
	});

	it("rejects lastProgressReport before createdAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "running",
				connectedAt: "2026-03-10T10:00:30.000Z",
				lastProgressReport: {
					kind: "progress",
					summary: "too early",
					data: null,
					reportedAt: "2026-03-10T09:59:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "lastProgressReport.reportedAt must be on or after createdAt",
		});
	});

	it("rejects lastProgressReport before connectedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "running",
				connectedAt: "2026-03-10T10:02:00.000Z",
				lastProgressReport: {
					kind: "progress",
					summary: "too early",
					data: null,
					reportedAt: "2026-03-10T10:01:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "lastProgressReport.reportedAt must be on or after connectedAt",
		});
	});

	it("rejects sidecar-derived fields before connectedAt even in non-handshake states", () => {
		expect(
			validateSubagentRecord(
				makeRecord({
					state: "starting",
					lastProgressReport: {
						kind: "progress",
						summary: "unexpected progress",
						data: null,
						reportedAt: "2026-03-10T10:01:00.000Z",
					},
				}),
			),
		).toEqual({
			ok: false,
			error: "sidecar-derived fields require connectedAt",
		});

		expect(
			validateSubagentRecord(
				makeRecord({
					state: "failed",
					error: {
						message: "child exited",
						recordedAt: "2026-03-10T10:01:30.000Z",
						fatal: true,
					},
					userIntervened: {
						source: "tmux",
						mode: "direct-chat",
						inputSource: "interactive-user",
						recordedAt: "2026-03-10T10:01:00.000Z",
					},
				}),
			),
		).toEqual({
			ok: false,
			error: "sidecar-derived fields require connectedAt",
		});

		expect(
			validateSubagentRecord(
				makeRecord({
					state: "waiting",
					pendingInputRequest: {
						kind: "needs_input",
						summary: "Need approval",
						data: null,
						reportedAt: "2026-03-10T10:01:00.000Z",
					},
				}),
			),
		).toEqual({
			ok: false,
			error: "waiting records must include connectedAt",
		});
	});

	it("rejects connectedAt on pre-handshake states", () => {
		expect(
			validateSubagentRecord(
				makeRecord({
					state: "starting",
					connectedAt: "2026-03-10T10:01:00.000Z",
				}),
			),
		).toEqual({
			ok: false,
			error: "starting records may not include connectedAt",
		});
	});

	it("rejects connectedAt on connecting records even when sidecar fields are present", () => {
		expect(
			validateSubagentRecord(
				makeRecord({
					state: "connecting",
					connectedAt: "2026-03-10T10:01:00.000Z",
					lastProgressReport: {
						kind: "progress",
						summary: "unexpected progress",
						data: null,
						reportedAt: "2026-03-10T10:02:00.000Z",
					},
				}),
			),
		).toEqual({
			ok: false,
			error: "connecting records may not include connectedAt",
		});
	});

	it("normalizes persisted explicit report data undefined to null", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "running",
				connectedAt: "2026-03-10T10:01:00.000Z",
				lastProgressReport: {
					kind: "progress",
					summary: "update",
					data: undefined,
					reportedAt: "2026-03-10T10:02:00.000Z",
				},
			}),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.lastProgressReport?.data).toBeNull();
	});

	it("rejects userIntervened before connectedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "running",
				connectedAt: "2026-03-10T10:02:00.000Z",
				userIntervened: {
					source: "tmux",
					mode: "direct-chat",
					inputSource: "interactive-user",
					recordedAt: "2026-03-10T10:01:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "userIntervened.recordedAt must be on or after connectedAt",
		});
	});

	it("rejects error before createdAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "failed",
				error: {
					message: "too early",
					recordedAt: "2026-03-10T09:59:00.000Z",
					fatal: true,
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "error.recordedAt must be on or after createdAt",
		});
	});

	it("rejects error before connectedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "failed",
				connectedAt: "2026-03-10T10:05:00.000Z",
				error: {
					message: "too early",
					recordedAt: "2026-03-10T10:01:00.000Z",
					fatal: true,
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "error.recordedAt must be on or after connectedAt",
		});
	});

	it("rejects pendingInputRequest before connectedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "waiting",
				connectedAt: "2026-03-10T10:02:00.000Z",
				pendingInputRequest: {
					kind: "needs_input",
					summary: "too early",
					data: null,
					reportedAt: "2026-03-10T10:01:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "pendingInputRequest.reportedAt must be on or after connectedAt",
		});
	});

	it("rejects malformed error payloads", () => {
		const result = validateSubagentRecord(
			makeRecord({
				error: {
					message: "child exited",
					recordedAt: "2026-03-10T10:05:00.000Z",
					fatal: "nope" as unknown as boolean,
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "error.fatal must be a boolean",
		});
	});

	it("rejects failed records without error", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "failed",
				connectedAt: "2026-03-10T10:02:00.000Z",
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "failed records must include error",
		});
	});

	it("rejects non-failed records with terminal error payloads", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "running",
				connectedAt: "2026-03-10T10:02:00.000Z",
				error: {
					message: "should not be here",
					recordedAt: "2026-03-10T10:03:00.000Z",
					fatal: true,
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "error may only be present when state is failed",
		});
	});

	it("rejects failed records whose error predates startedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "failed",
				startedAt: "2026-03-10T10:02:00.000Z",
				error: {
					message: "too early",
					recordedAt: "2026-03-10T10:01:00.000Z",
					fatal: true,
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "error.recordedAt must be on or after startedAt",
		});
	});

	it("rejects failed records with sidecar activity after terminal failure", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "failed",
				connectedAt: "2026-03-10T10:02:00.000Z",
				error: {
					message: "child exited",
					recordedAt: "2026-03-10T10:05:00.000Z",
					fatal: true,
				},
				lastProgressReport: {
					kind: "progress",
					summary: "late progress",
					data: null,
					reportedAt: "2026-03-10T10:06:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "lastProgressReport.reportedAt must be on or before terminal failure",
		});
	});

	it("rejects failed records with needs_input after terminal failure", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "failed",
				connectedAt: "2026-03-10T10:02:00.000Z",
				error: {
					message: "child exited",
					recordedAt: "2026-03-10T10:05:00.000Z",
					fatal: true,
				},
				pendingInputRequest: {
					kind: "needs_input",
					summary: "late blocker",
					data: null,
					reportedAt: "2026-03-10T10:06:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "pendingInputRequest.reportedAt must be on or before terminal failure",
		});
	});

	it("accepts stopped records with historical sidecar-derived fields bounded by stoppedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "stopped",
				connectedAt: "2026-03-10T10:02:00.000Z",
				stoppedAt: "2026-03-10T10:05:00.000Z",
				lastProgressReport: {
					kind: "progress",
					summary: "done enough",
					data: null,
					reportedAt: "2026-03-10T10:04:00.000Z",
				},
				userIntervened: {
					source: "tmux",
					mode: "direct-chat",
					inputSource: "interactive-user",
					recordedAt: "2026-03-10T10:03:30.000Z",
				},
			}),
		);
		expect(result.ok).toBe(true);
	});

	it("rejects stopped records without stoppedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "stopped",
				connectedAt: "2026-03-10T10:02:00.000Z",
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "stopped records must include stoppedAt",
		});
	});

	it("rejects stopped records with sidecar-derived fields after stoppedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "stopped",
				connectedAt: "2026-03-10T10:02:00.000Z",
				stoppedAt: "2026-03-10T10:03:00.000Z",
				lastProgressReport: {
					kind: "progress",
					summary: "late progress",
					data: null,
					reportedAt: "2026-03-10T10:04:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "lastProgressReport.reportedAt must be on or before terminal stop",
		});
	});

	it("rejects degradedAt on non-degraded records", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "running",
				connectedAt: "2026-03-10T10:02:00.000Z",
				degradedAt: "2026-03-10T10:03:00.000Z",
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "degradedAt may only be present when state is degraded",
		});
	});

	it("rejects degraded records with progress after degradedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "degraded",
				connectedAt: "2026-03-10T10:02:00.000Z",
				degradedAt: "2026-03-10T10:05:00.000Z",
				lastProgressReport: {
					kind: "progress",
					summary: "late progress",
					data: null,
					reportedAt: "2026-03-10T10:06:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "lastProgressReport.reportedAt must be on or before degradedAt",
		});
	});

	it("rejects degraded records with needs_input after degradedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "degraded",
				connectedAt: "2026-03-10T10:02:00.000Z",
				degradedAt: "2026-03-10T10:05:00.000Z",
				pendingInputRequest: {
					kind: "needs_input",
					summary: "late blocker",
					data: null,
					reportedAt: "2026-03-10T10:06:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "pendingInputRequest.reportedAt must be on or before degradedAt",
		});
	});

	it("rejects degraded records with user intervention after degradedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "degraded",
				connectedAt: "2026-03-10T10:02:00.000Z",
				degradedAt: "2026-03-10T10:05:00.000Z",
				userIntervened: {
					source: "tmux",
					mode: "direct-chat",
					inputSource: "interactive-user",
					recordedAt: "2026-03-10T10:06:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "userIntervened.recordedAt must be on or before degradedAt",
		});
	});

	it("rejects non-ISO timestamps even when Date.parse would accept them", () => {
		const result = validateSubagentRecord(
			makeRecord({
				createdAt: "March 10, 2026" as unknown as string,
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "createdAt must be an ISO timestamp",
		});
	});

	it("rejects completed records with progress after final completion", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "completed",
				connectedAt: "2026-03-10T10:01:00.000Z",
				completedAt: "2026-03-10T10:05:00.000Z",
				lastProgressReport: {
					kind: "progress",
					summary: "late progress",
					data: null,
					reportedAt: "2026-03-10T10:06:00.000Z",
				},
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "2026-03-10T10:05:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "lastProgressReport.reportedAt must be on or before terminal completion",
		});
	});

	it("rejects completed records whose finalResult is after completedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "completed",
				connectedAt: "2026-03-10T10:04:00.000Z",
				completedAt: "2026-03-10T10:05:00.000Z",
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "2026-03-10T10:06:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "finalResult.reportedAt must be on or before completedAt",
		});
	});

	it("rejects completed records with sidecar activity after final_result even when completedAt is later", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "completed",
				connectedAt: "2026-03-10T10:01:00.000Z",
				completedAt: "2026-03-10T10:06:00.000Z",
				lastProgressReport: {
					kind: "progress",
					summary: "late progress",
					data: null,
					reportedAt: "2026-03-10T10:05:30.000Z",
				},
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "2026-03-10T10:05:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "lastProgressReport.reportedAt must be on or before terminal completion",
		});
	});

	it("rejects completed records whose finalResult is before createdAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "completed",
				connectedAt: "2026-03-10T10:01:00.000Z",
				completedAt: "2026-03-10T10:05:00.000Z",
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "2026-03-10T09:59:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "finalResult.reportedAt must be on or after createdAt",
		});
	});

	it("rejects completed records whose finalResult is before connectedAt", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "completed",
				connectedAt: "2026-03-10T10:03:00.000Z",
				completedAt: "2026-03-10T10:05:00.000Z",
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "2026-03-10T10:02:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "finalResult.reportedAt must be on or after connectedAt",
		});
	});

	it("rejects completed records with user intervention after terminal completion", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "completed",
				connectedAt: "2026-03-10T10:01:00.000Z",
				completedAt: "2026-03-10T10:05:00.000Z",
				userIntervened: {
					source: "tmux",
					mode: "direct-chat",
					inputSource: "interactive-user",
					recordedAt: "2026-03-10T10:06:00.000Z",
				},
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "2026-03-10T10:05:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "userIntervened.recordedAt must be on or before terminal completion",
		});
	});

	it("rejects completed records with needs_input after terminal completion", () => {
		const result = validateSubagentRecord(
			makeRecord({
				state: "completed",
				connectedAt: "2026-03-10T10:01:00.000Z",
				completedAt: "2026-03-10T10:05:00.000Z",
				pendingInputRequest: {
					kind: "needs_input",
					summary: "late blocker",
					data: null,
					reportedAt: "2026-03-10T10:06:00.000Z",
				},
				finalResult: {
					kind: "final_result",
					summary: "done",
					data: null,
					reportedAt: "2026-03-10T10:05:00.000Z",
				},
			}),
		);
		expect(result).toEqual({
			ok: false,
			error: "pendingInputRequest.reportedAt must be on or before terminal completion",
		});
	});

	it.each([
		makeRecord({ id: " " }),
		makeRecord({ sessionPath: "session.jsonl" }),
		makeRecord({ socketPath: "" }),
		makeRecord({ tmuxTarget: "" }),
		makeRecord({ childMode: "embedded" as SubagentRecord["childMode"] }),
		makeRecord({ createdAt: "bad-date" }),
	])("rejects invalid record shape %#", (record) => {
		const result = validateSubagentRecord(record);
		expect(result.ok).toBe(false);
	});
});
