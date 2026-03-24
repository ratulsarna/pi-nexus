import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parentExtensionPath = path.join(repoRoot, "dist", "parent-extension.js");
const bootstrapExtensionPath = path.join(repoRoot, "dist", "subagent-bootstrap-extension.js");
const artifactDir = path.join(os.homedir(), ".ai", "pi-nexus", "RAT-133");
const logPath = path.join(artifactDir, "manual-acceptance-rat-133.log");
const runId = Date.now().toString(36);
const runtimeDir = path.join(artifactDir, `r-${runId}`);
const sessionPath = path.join(runtimeDir, "main-session.jsonl");
const piPathOverride = process.env.RAT131_PI_PATH;
const piBinDirOverride = process.env.RAT131_PI_BIN_DIR;
const candidatePiBinDirs = [
	piBinDirOverride,
	path.join(repoRoot, "node_modules", ".bin"),
	path.resolve(repoRoot, "..", "pi-mono", "node_modules", ".bin"),
].filter((value, index, values) => typeof value === "string" && value.length > 0 && values.indexOf(value) === index);

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

function canExecute(filePath) {
	try {
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function sameExecutable(leftPath, rightPath) {
	try {
		return fs.realpathSync.native(leftPath) === fs.realpathSync.native(rightPath);
	} catch {
		return path.resolve(leftPath) === path.resolve(rightPath);
	}
}

function makeAuthoritativePiShim(targetPath) {
	const shimDir = path.join(runtimeDir, "pi-bin");
	const shimPath = path.join(shimDir, "pi");
	fs.mkdirSync(shimDir, { recursive: true });
	fs.writeFileSync(
		shimPath,
		`#!/bin/sh\nexec ${JSON.stringify(targetPath)} "$@"\n`,
		{ mode: 0o755 },
	);
	return shimPath;
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

function shQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
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
		await sleep(250);
	}
	fail(`timed out waiting for ${label}`);
}

function ensureBuiltPiOnPath() {
	let expectedLaunchPiPath;
	if (typeof piPathOverride === "string" && piPathOverride.length > 0) {
		if (!canExecute(piPathOverride)) {
			fail(`RAT131_PI_PATH is not executable: ${piPathOverride}`);
		}
		expectedLaunchPiPath = path.basename(piPathOverride) === "pi"
			? piPathOverride
			: makeAuthoritativePiShim(piPathOverride);
		const overrideBinDir = path.dirname(expectedLaunchPiPath);
		process.env.PATH = [overrideBinDir, process.env.PATH]
			.filter((value) => typeof value === "string" && value.length > 0)
			.join(path.delimiter);
	} else {
		if (typeof piBinDirOverride === "string" && piBinDirOverride.length > 0) {
			expectedLaunchPiPath = path.join(piBinDirOverride, "pi");
			if (!canExecute(expectedLaunchPiPath)) {
				fail(`RAT131_PI_BIN_DIR does not contain an executable pi: ${expectedLaunchPiPath}`);
			}
		}

		const candidateExistingBinDirs = candidatePiBinDirs.filter((binDir) => fs.existsSync(binDir));
		process.env.PATH = [...candidateExistingBinDirs, process.env.PATH]
			.filter((value) => typeof value === "string" && value.length > 0)
			.join(path.delimiter);
	}

	const resolvedPiPath = requireExecutable("pi");
	if (expectedLaunchPiPath && !sameExecutable(resolvedPiPath, expectedLaunchPiPath)) {
		fail(`resolved pi does not match expected executable: ${resolvedPiPath}`);
	}
	const version = run(resolvedPiPath, ["--version"], { env: process.env });
	log(`pi: ${resolvedPiPath} (${version})`);
	return resolvedPiPath;
}

function assertBuildArtifacts() {
	if (!fs.existsSync(parentExtensionPath) || !fs.existsSync(bootstrapExtensionPath)) {
		fail("build artifacts are missing; run `npm run build` before manual acceptance");
	}
}

function capturePane(target) {
	return run("tmux", ["capture-pane", "-p", "-t", target]);
}

async function waitForPaneText(target, text, timeoutMs) {
	return waitFor(() => {
		const captured = capturePane(target);
		return captured.includes(text) ? captured : false;
	}, timeoutMs, `${target} to contain ${JSON.stringify(text)}`);
}

async function waitForStablePane(target, quietMs, timeoutMs) {
	let lastCapture = "";
	let stableSince = 0;
	return waitFor(() => {
		const capture = capturePane(target);
		const now = Date.now();
		if (capture === lastCapture) {
			if (stableSince === 0) {
				stableSince = now;
			}
			if (now - stableSince >= quietMs) {
				return capture;
			}
		} else {
			lastCapture = capture;
			stableSince = 0;
		}
		return false;
	}, timeoutMs, `${target} stable for ${quietMs}ms`);
}

function sendLine(target, text) {
	run("tmux", ["send-keys", "-t", target, "-l", text]);
	run("tmux", ["send-keys", "-t", target, "Enter"]);
}

async function runFocusCommandBriefly(focusCommand) {
	const scriptPath = requireExecutable("script");
	log(`focus proof using ${scriptPath}`);
	const child = spawn(scriptPath, ["-q", "/dev/null", "bash", "-lc", focusCommand], {
		stdio: ["ignore", "pipe", "pipe"],
	});

	await sleep(1500);
	if (child.exitCode !== null) {
		const stdout = child.stdout?.read()?.toString("utf8") ?? "";
		const stderr = child.stderr?.read()?.toString("utf8") ?? "";
		fail(`focus command exited too early: stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`);
	}

	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
}

function listTmuxSessions() {
	const output = run("tmux", ["list-sessions", "-F", "#{session_name}"]);
	return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

function latestWidgetLineForAgent(text, agentId) {
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const trimmed = lines[index].trim();
		if (trimmed.startsWith(agentId) && trimmed.includes("state=")) {
			return trimmed;
		}
	}
	return undefined;
}

async function waitForAgentWidgetLine(target, agentId, predicate, timeoutMs, label) {
	return waitFor(() => {
		const line = latestWidgetLineForAgent(capturePane(target), agentId);
		if (!line || !predicate(line)) {
			return false;
		}
		return line;
	}, timeoutMs, label);
}

async function main() {
	log("RAT-133 manual acceptance started");
	const tmuxPath = requireExecutable("tmux");
	log(`tmux: ${tmuxPath}`);
	assertBuildArtifacts();
	const piPath = ensureBuiltPiOnPath();

	const mainSessionName = `rat133_main_${runId}`;
	const mainPaneTarget = `${mainSessionName}:main`;
	let childSessionName;

	try {
		run("tmux", [
			"new-session",
			"-d",
			"-s",
			mainSessionName,
			"-n",
			"main",
			`${shQuote(piPath)} --no-extensions -e ${shQuote(parentExtensionPath)} --session ${shQuote(sessionPath)}`,
		]);
		log(`created main pi tmux target ${mainPaneTarget}`);
		const sessionsBeforeSpawn = new Set(listTmuxSessions());

		await sleep(3000);
		const spawnPrompt = [
			"Use the Subagent tool exactly once right now with action spawn.",
			"Spawn a general-purpose subagent with description RAT133 acceptance and tmux_mode window.",
			"The subagent prompt must instruct the child to call report_to_parent twice: first kind progress summary RAT133 child started, then kind final_result summary RAT133 child finished, then wait silently for more input.",
			"Do not use any other tool.",
			"After the Subagent tool call succeeds, stop.",
		].join(" ");
		sendLine(mainPaneTarget, spawnPrompt);
		log("sent parent spawn prompt");

		const afterSpawn = await waitForPaneText(mainPaneTarget, "Spawned subagent agt_", 180_000);
		const agentIdMatch = afterSpawn.match(/Spawned subagent (agt_[A-Za-z0-9_]+)/);
		if (!agentIdMatch) {
			fail("could not parse spawned agent id from main pane");
		}
		const agentId = agentIdMatch[1];
		log(`spawned agent ${agentId}`);

		await waitForPaneText(mainPaneTarget, "Subagent progress from", 180_000);
		await waitForPaneText(mainPaneTarget, "RAT133 child started", 180_000);
		await waitForPaneText(mainPaneTarget, "Subagent final_result from", 180_000);
		await waitForPaneText(mainPaneTarget, "RAT133 child finished", 180_000);
		await waitForStablePane(mainPaneTarget, 1500, 60_000);

		const liveWidgetLine = await waitForAgentWidgetLine(
			mainPaneTarget,
			agentId,
			(line) => line.includes("state=running") && !line.includes("[stale]"),
			30_000,
			`subagent widget line for ${agentId} in running state`,
		);
		if (!liveWidgetLine.includes("state=running")) {
			fail(`expected widget to show ${agentId} as running`);
		}
		log("verified live widget state");

		const sessionsAfterSpawn = new Set(listTmuxSessions());
		childSessionName = Array.from(sessionsAfterSpawn).find(
			(sessionName) => !sessionsBeforeSpawn.has(sessionName) && sessionName !== mainSessionName,
		);
		if (!childSessionName) {
			fail("could not identify spawned child tmux session");
		}
		const childTarget = `${childSessionName}:child`;
		log(`identified child tmux target ${childTarget}`);

		sendLine(
			mainPaneTarget,
			`Use the Subagent tool exactly once right now with action open, agent_id ${agentId}, and mode follow. Do not use any other tool. Stop after the tool call succeeds.`,
		);
		await waitForPaneText(mainPaneTarget, `Subagent ${agentId}`, 30_000);
		await waitForPaneText(mainPaneTarget, "Mode: follow", 30_000);
		log("verified native Follow screen rendered");
		run("tmux", ["send-keys", "-t", mainPaneTarget, "Escape"]);
		await sleep(500);

		sendLine(childTarget, "Direct tmux intervention. Do not call report_to_parent yet. Wait silently for another message.");
		await waitForPaneText(mainPaneTarget, "assumptions are stale", 60_000);
		log("verified stale-after-intervention status surfaced in parent");

		const staleWidgetLine = await waitForAgentWidgetLine(
			mainPaneTarget,
			agentId,
			(line) => line.includes("[stale]"),
			30_000,
			`subagent widget line for ${agentId} with stale marker`,
		);
		if (!staleWidgetLine.includes("[stale]")) {
			fail("expected widget to show stale marker after direct child intervention");
		}

		sendLine(childTarget, "Please call report_to_parent with kind progress and summary RAT133 child refreshed, then wait silently.");
		await waitForPaneText(mainPaneTarget, "RAT133 child refreshed", 120_000);
		await waitForStablePane(mainPaneTarget, 1500, 60_000);

		const refreshedWidgetLine = await waitForAgentWidgetLine(
			mainPaneTarget,
			agentId,
			(line) => line.includes("state=running") && !line.includes("[stale]"),
			30_000,
			`subagent widget line for ${agentId} with cleared stale marker`,
		);
		if (refreshedWidgetLine.includes("[stale]")) {
			fail("expected widget to clear stale marker after a fresh child-authored report");
		}
		log("verified stale marker clears only after explicit child-authored report");

		sendLine(mainPaneTarget, "/quit");
		await waitFor(() => {
			const result = spawnSync("tmux", ["has-session", "-t", mainSessionName], { stdio: "ignore" });
			return result.status !== 0;
		}, 30_000, "main pi session shutdown");

		if (childSessionName) {
			const childSessionCheck = spawnSync("tmux", ["has-session", "-t", childSessionName], { stdio: "ignore" });
			if (childSessionCheck.status === 0) {
				fail(`expected child tmux session to be cleaned up on main-session exit: ${childSessionName}`);
			}
		}
		log("verified child cleanup on main-session exit");

		log("RAT-133 manual acceptance passed");
	} finally {
		if (childSessionName) {
			spawnSync("tmux", ["kill-session", "-t", childSessionName], {
				stdio: "ignore",
			});
		}
		spawnSync("tmux", ["kill-session", "-t", mainSessionName], {
			stdio: "ignore",
		});
	}
}

main().catch((error) => {
	log(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
