import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distIndexPath = path.join(repoRoot, "dist", "index.js");
const bootstrapExtensionPath = path.join(repoRoot, "dist", "subagent-bootstrap-extension.js");
const artifactDir = path.join(os.homedir(), ".ai", "pi-nexus", "RAT-135");
const logPath = path.join(artifactDir, "manual-acceptance-rat-135.log");
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

async function waitForReadyOrFailure(manager, agentId, timeoutMs) {
	return waitFor(() => {
		const recordResult = manager.getRecord(agentId);
		if (!recordResult.ok) {
			return false;
		}

		const record = recordResult.value;
		if (record.state === "ready" || record.state === "running" || record.state === "needs_input" || record.state === "waiting") {
			return record;
		}
		if (record.state === "failed" || record.state === "stopped") {
			const reason = record.error?.message ? `: ${record.error.message}` : "";
			fail(`runtime ${agentId} entered terminal state ${record.state}${reason}`);
		}
		return false;
	}, timeoutMs, `${agentId} ready`);
}

async function waitForRecordState(manager, agentId, expectedState, timeoutMs) {
	return waitFor(() => {
		const recordResult = manager.getRecord(agentId);
		if (!recordResult.ok) {
			return false;
		}

		const record = recordResult.value;
		if (record.state === expectedState) {
			return record;
		}
		if (record.state === "failed" || record.state === "stopped") {
			const reason = record.error?.message ? `: ${record.error.message}` : "";
			fail(`runtime ${agentId} entered terminal state ${record.state}${reason}`);
		}
		return false;
	}, timeoutMs, `${agentId} state ${expectedState}`);
}

async function waitForChildMessages(messagesByAgent, agentId, predicate, timeoutMs, label) {
	return waitFor(() => {
		const messages = messagesByAgent.get(agentId) ?? [];
		return predicate(messages) ? messages : false;
	}, timeoutMs, `${agentId} ${label}`);
}

function assertPaneAlive(tmuxTarget, label) {
	const paneState = run("tmux", ["list-panes", "-t", tmuxTarget, "-F", "#{pane_dead}:#{pane_pid}"]);
	log(`tmux pane state for ${label}: ${paneState}`);
	if (paneState.startsWith("1:")) {
		fail(`tmux pane is dead for ${label}`);
	}
}

function createBootstrap(agentId, tmuxTarget, initialPrompt) {
	return {
		agentId,
		sessionPath: path.join(runtimeDir, `${agentId}.session.jsonl`),
		socketPath: path.join(runtimeDir, `${agentId}.sock`),
		tmuxMode: "window",
		tmuxTarget,
		initialPrompt,
		bootstrapExtensionPath,
		cwd: repoRoot,
		childMode: "interactive-cli",
	};
}

async function main() {
	log("RAT-135 manual acceptance started");
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

	const observedChildMessages = [];
	const messagesByAgent = new Map();
	const tmuxSessions = [];

	const manager = new SubagentManager({
		sidecarSessions: new NodeSidecarSessionAdapter({
			onEnvelope(direction, message) {
				log(`${direction}: ${JSON.stringify(message)}`);
				if (direction !== "child_to_parent" || typeof message !== "object" || message === null) {
					return;
				}

				observedChildMessages.push(message);
				const agentId = typeof message.agentId === "string" ? message.agentId : undefined;
				if (!agentId) {
					return;
				}

				const existing = messagesByAgent.get(agentId) ?? [];
				existing.push(message);
				messagesByAgent.set(agentId, existing);
			},
		}),
		runtimeProcesses: new TmuxSubagentProcessAdapter({
			exitMarkerDir: runtimeDir,
		}),
	});

	try {
		const completionAgentId = `rat135_completion_${runId}`;
		const completionSessionName = `${completionAgentId}_tmux`;
		const completionTmuxTarget = `${completionSessionName}:child`;
		tmuxSessions.push(completionSessionName);
		run("tmux", ["new-session", "-d", "-s", completionSessionName, "-n", "child"]);
		log(`created completion tmux target ${completionTmuxTarget}`);

		const completionBootstrap = createBootstrap(
			completionAgentId,
			completionTmuxTarget,
			[
				"You are validating a reserved machine-facing reporting tool named report_to_parent.",
				"Call report_to_parent exactly twice.",
				"First call: kind progress with a short summary that work has started.",
				"Second call: kind final_result with a short summary that work is complete.",
				"Do not ask clarifying questions. Do not wait for more input.",
			].join(" "),
		);
		const completionBootstrapConfigPath = path.join(runtimeDir, `${completionAgentId}.bootstrap.json`);
		fs.writeFileSync(
			completionBootstrapConfigPath,
			`${JSON.stringify(completionBootstrap, null, 2)}\n`,
			"utf8",
		);
		const completionLaunchSpecResult = createRuntimeLaunchSpec(
			completionBootstrap,
			completionBootstrapConfigPath,
		);
		if (!completionLaunchSpecResult.ok) {
			fail(`failed to create completion launch spec: ${completionLaunchSpecResult.error}`);
		}
		const completionSpawn = manager.spawn({
			type: "acceptance",
			description: "RAT-135 completion-path runtime",
			launchSpec: completionLaunchSpecResult.value,
		});
		if (!completionSpawn.ok) {
			fail(`completion spawn failed: ${completionSpawn.error}`);
		}

		await waitForReadyOrFailure(manager, completionAgentId, 45_000);
		const completionMessages = await waitForChildMessages(
			messagesByAgent,
			completionAgentId,
			(messages) => {
				const firstProgressIndex = messages.findIndex((message) => message.type === "progress");
				const firstFinalIndex = messages.findIndex((message) => message.type === "final_result");
				return firstProgressIndex >= 0 && firstFinalIndex > firstProgressIndex;
			},
			120_000,
			"progress before final_result",
		);
		const completionRecord = await waitFor(() => {
			const recordResult = manager.getRecord(completionAgentId);
			if (!recordResult.ok) {
				return false;
			}
			return recordResult.value.finalResultHistory?.length ? recordResult.value : false;
		}, 15_000, `${completionAgentId} final result record`);

		if (!completionRecord.lastProgressReport) {
			fail("completion record is missing lastProgressReport after real progress event");
		}
		if (!completionRecord.finalResultHistory?.length) {
			fail("completion record is missing finalResultHistory after real final_result event");
		}
		if (completionRecord.state !== "running") {
			fail(`completion record should remain running after final_result, received ${completionRecord.state}`);
		}
		log(
			`completion path observed ${completionMessages.filter((message) => message.type === "progress" || message.type === "final_result").map((message) => message.type).join(" -> ")}`,
		);
		assertPaneAlive(completionTmuxTarget, "completion path");

		const interruptAgentId = `rat135_interrupt_${runId}`;
		const interruptSessionName = `${interruptAgentId}_tmux`;
		const interruptTmuxTarget = `${interruptSessionName}:child`;
		tmuxSessions.push(interruptSessionName);
		run("tmux", ["new-session", "-d", "-s", interruptSessionName, "-n", "child"]);
		log(`created interrupt tmux target ${interruptTmuxTarget}`);

		const interruptBootstrap = createBootstrap(
			interruptAgentId,
			interruptTmuxTarget,
			[
				"You are validating the reserved machine-facing report_to_parent tool.",
				"Call report_to_parent exactly once with kind needs_input and a short approval question.",
				"After that tool call, wait for more user input and do not send a final answer.",
			].join(" "),
		);
		const interruptBootstrapConfigPath = path.join(runtimeDir, `${interruptAgentId}.bootstrap.json`);
		fs.writeFileSync(
			interruptBootstrapConfigPath,
			`${JSON.stringify(interruptBootstrap, null, 2)}\n`,
			"utf8",
		);
		const interruptLaunchSpecResult = createRuntimeLaunchSpec(
			interruptBootstrap,
			interruptBootstrapConfigPath,
		);
		if (!interruptLaunchSpecResult.ok) {
			fail(`failed to create interrupt launch spec: ${interruptLaunchSpecResult.error}`);
		}
		const interruptSpawn = manager.spawn({
			type: "acceptance",
			description: "RAT-135 interrupt-path runtime",
			launchSpec: interruptLaunchSpecResult.value,
		});
		if (!interruptSpawn.ok) {
			fail(`interrupt spawn failed: ${interruptSpawn.error}`);
		}

		await waitForReadyOrFailure(manager, interruptAgentId, 45_000);
		const needsInputRecord = await waitForRecordState(manager, interruptAgentId, "needs_input", 120_000);
		if (!needsInputRecord.pendingInputRequest) {
			fail("interrupt path did not record a pending input request before interrupt");
		}

		const interruptResult = manager.sendInterrupt(interruptAgentId);
		if (!interruptResult.ok) {
			fail(`sendInterrupt failed: ${interruptResult.error}`);
		}
		log(`sent interrupt seq ${interruptResult.value.seq} to ${interruptAgentId}`);

		const interruptMessages = await waitForChildMessages(
			messagesByAgent,
			interruptAgentId,
			(messages) => {
				const needsInputIndex = messages.findIndex((message) => message.type === "needs_input");
				const waitingIndex = messages.findIndex(
					(message) => message.type === "state" && message.payload?.status === "waiting",
				);
				return needsInputIndex >= 0 && waitingIndex > needsInputIndex;
			},
			60_000,
			"needs_input before child-authored waiting",
		);
		const waitingRecord = await waitForRecordState(manager, interruptAgentId, "waiting", 15_000);
		if (waitingRecord.pendingInputRequest !== undefined) {
			fail("interrupt path should clear pendingInputRequest once child reports waiting");
		}
		log(
			`interrupt path observed ${interruptMessages.filter((message) => message.type === "needs_input" || message.type === "state").map((message) => message.type === "state" ? `state:${message.payload?.status}` : message.type).join(" -> ")}`,
		);
		assertPaneAlive(interruptTmuxTarget, "interrupt path");

		log("PASS: real progress -> final_result path verified through the live seam");
		log("PASS: real needs_input -> interrupt -> waiting path verified through the live seam");
		log(`observed ${observedChildMessages.length} child event(s) across both acceptance paths`);
		log(`saved acceptance log to ${logPath}`);
	} finally {
		const shutdownResult = manager.shutdownAll();
		if (shutdownResult.ok) {
			log(`shutdownAll closed ${shutdownResult.value.length} managed runtime(s)`);
		} else {
			log(`shutdownAll returned validation error: ${shutdownResult.error}`);
		}
		for (const sessionName of tmuxSessions) {
			try {
				spawnSync("tmux", ["kill-session", "-t", sessionName], {
					stdio: "ignore",
				});
			} catch {
				log(`warning: failed to kill tmux session ${sessionName}`);
			}
		}
	}
}

main().catch((error) => {
	log(`fatal error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
