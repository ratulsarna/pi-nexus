import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distIndexPath = path.join(repoRoot, "dist", "index.js");
const bootstrapExtensionPath = path.join(repoRoot, "dist", "subagent-bootstrap-extension.js");
const artifactDir = path.join(os.homedir(), ".ai", "pi-nexus", "RAT-134");
const logPath = path.join(artifactDir, "manual-acceptance-rat-134.log");
const runId = Date.now().toString(36);
const runtimeDir = path.join(artifactDir, `r-${runId}`);

fs.mkdirSync(artifactDir, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });
fs.writeFileSync(logPath, "", "utf8");

function log(message) {
	const line = `[${new Date().toISOString()}] ${message}`;
	process.stdout.write(`${line}\n`);
	fs.appendFileSync(logPath, `${line}\n`, "utf8");
}

function fail(message) {
	log(`FAIL: ${message}`);
	process.exitCode = 1;
	throw new Error(message);
}

function requireExecutable(command) {
	const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		fail(`missing prerequisite: ${command}`);
	}
	return result.stdout.trim();
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		...options,
	});
	if (result.status !== 0) {
		const stderr = result.stderr?.trim();
		const stdout = result.stdout?.trim();
		fail(
			`${command} ${args.join(" ")} failed` +
				(stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ""),
		);
	}
	return result.stdout.trim();
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) {
			return value;
		}
		await sleep(100);
	}
	fail(`timed out waiting for ${label}`);
}

async function waitForReadyOrTerminal(manager, agentId, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const recordResult = manager.getRecord(agentId);
		if (recordResult.ok) {
			const record = recordResult.value;
			if (record.state === "ready") {
				return record;
			}
			if (record.state === "failed" || record.state === "degraded" || record.state === "stopped") {
				const reason = record.error?.message ? `: ${record.error.message}` : "";
				fail(`runtime entered terminal state ${record.state}${reason}`);
			}
		}
		await sleep(100);
	}

	fail("timed out waiting for record ready");
}

async function main() {
	log("RAT-134 manual acceptance started");
	const piPath = requireExecutable("pi");
	const tmuxPath = requireExecutable("tmux");
	log(`pi: ${piPath}`);
	log(`tmux: ${tmuxPath}`);

	if (!fs.existsSync(distIndexPath) || !fs.existsSync(bootstrapExtensionPath)) {
		fail("build artifacts are missing; run `npm run build` before manual acceptance");
	}

	const {
		NodeSidecarSessionAdapter,
		SubagentManager,
		TmuxSubagentProcessAdapter,
		createRuntimeLaunchSpec,
	} = await import(pathToFileURL(distIndexPath).href);

	const tmuxSessionName = `rat134_${runId}`;
	const tmuxWindowName = "child";
	const tmuxTarget = `${tmuxSessionName}:${tmuxWindowName}`;
	const agentId = `rat134_${runId}`;
	const sessionPath = path.join(runtimeDir, "s.jsonl");
	const socketPath = path.join(runtimeDir, "b.sock");
	const bootstrapConfigPath = path.join(runtimeDir, "bootstrap.json");
	const observedChildMessages = [];

	log(`runtimeDir: ${runtimeDir}`);
	log(`logPath: ${logPath}`);
	run("tmux", ["new-session", "-d", "-s", tmuxSessionName, "-n", tmuxWindowName]);
	log(`created tmux target ${tmuxTarget}`);

	const bootstrapConfig = {
		agentId,
		sessionPath,
		socketPath,
		tmuxMode: "window",
		tmuxTarget,
		initialPrompt: "/hotkeys",
		bootstrapExtensionPath,
		cwd: repoRoot,
		childMode: "interactive-cli",
	};
	fs.writeFileSync(bootstrapConfigPath, `${JSON.stringify(bootstrapConfig, null, 2)}\n`, "utf8");

	const launchSpecResult = createRuntimeLaunchSpec(bootstrapConfig, bootstrapConfigPath);
	if (!launchSpecResult.ok) {
		fail(`failed to create launch spec: ${launchSpecResult.error}`);
	}

	/** @type {(() => void) | undefined} */
	let pongResolve;
	const pongSeen = new Promise((resolve) => {
		pongResolve = resolve;
	});

	const manager = new SubagentManager({
		sidecarSessions: new NodeSidecarSessionAdapter({
			onEnvelope(direction, message) {
				log(`${direction}: ${JSON.stringify(message)}`);
				if (direction === "child_to_parent") {
					observedChildMessages.push(message);
					if (message.type === "pong") {
						pongResolve?.();
					}
				}
			},
		}),
		runtimeProcesses: new TmuxSubagentProcessAdapter({
			exitMarkerDir: runtimeDir,
		}),
	});

	try {
		const spawnResult = manager.spawn({
			type: "acceptance",
			description: "RAT-134 manual acceptance runtime",
			launchSpec: launchSpecResult.value,
		});
		if (!spawnResult.ok) {
			fail(`manager spawn failed: ${spawnResult.error}`);
		}
		log(`spawned record state: ${spawnResult.value.state}`);

		const readyRecord = await waitForReadyOrTerminal(manager, agentId, 30_000);
		log(`ready observed at ${readyRecord.connectedAt}`);

		const pingResult = manager.sendPing(agentId);
		if (!pingResult.ok) {
			fail(`sendPing failed: ${pingResult.error}`);
		}
		log(`sent ping seq ${pingResult.value.seq}`);

		await Promise.race([
			pongSeen,
			waitFor(
				() => observedChildMessages.some((message) => message.type === "pong"),
				15_000,
				"child pong",
			),
		]);
		log("pong observed from child");

		const paneState = run("tmux", ["list-panes", "-t", tmuxTarget, "-F", "#{pane_dead}:#{pane_pid}"]);
		log(`tmux pane state after ready: ${paneState}`);
		if (paneState.startsWith("1:")) {
			fail("tmux pane is dead after ready");
		}

		log("PASS: real hello -> ready -> pong path verified");
		log(`saved acceptance log to ${logPath}`);
	} finally {
		const shutdownResult = manager.shutdownAll();
		if (shutdownResult.ok) {
			log(`shutdownAll closed ${shutdownResult.value.length} managed runtime(s)`);
		} else {
			log(`shutdownAll returned validation error: ${shutdownResult.error}`);
		}
		try {
			spawnSync("tmux", ["kill-session", "-t", tmuxSessionName], {
				stdio: "ignore",
			});
		} catch {
			log(`warning: failed to kill tmux session ${tmuxSessionName}`);
		}
	}
}

main().catch((error) => {
	log(`fatal error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
