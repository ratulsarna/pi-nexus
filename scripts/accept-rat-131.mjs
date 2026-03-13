import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distIndexPath = path.join(repoRoot, "dist", "index.js");
const bootstrapExtensionPath = path.join(repoRoot, "dist", "subagent-bootstrap-extension.js");
const builtPiBinDir = "/Users/ratulsarna/Developer/pi/pi-mono/node_modules/.bin";
const builtPiPath = path.join(builtPiBinDir, "pi");
const artifactDir = path.join(os.homedir(), ".ai", "pi-nexus", "RAT-131");
const logPath = path.join(artifactDir, "manual-acceptance-rat-131.log");
const runId = Date.now().toString(36);
const runtimeDir = path.join(artifactDir, `r-${runId}`);
const summaryPath = path.join(runtimeDir, "summary.json");
const runFocusProof = process.env.RAT131_RUN_FOCUS_PROOF === "1";

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

async function waitForProcessExit(child, timeoutMs, label) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			child.kill("SIGTERM");
			reject(new Error(`timed out waiting for ${label}; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`));
		}, timeoutMs);

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr });
		});
	});
}

function ensureBuiltPiOnPath() {
	if (!fs.existsSync(builtPiPath)) {
		fail(`built pi executable not found at ${builtPiPath}`);
	}
	process.env.PATH = [builtPiBinDir, process.env.PATH].filter((value) => typeof value === "string" && value.length > 0).join(path.delimiter);
	const version = run(builtPiPath, ["--version"], {
		env: process.env,
	});
	log(`pi: ${builtPiPath} (${version})`);
}

function assertBuildArtifacts() {
	if (!fs.existsSync(distIndexPath) || !fs.existsSync(bootstrapExtensionPath)) {
		fail("build artifacts are missing; run `npm run build` before manual acceptance");
	}
}

function parsePaneListing(windowTarget) {
	const raw = run("tmux", ["list-panes", "-t", windowTarget, "-F", "#{session_name}:#{window_name}.#{pane_index}|#{pane_active}|#{pane_id}"]);
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [target, active, paneId] = line.split("|");
			return {
				target,
				active: active === "1",
				paneId,
			};
		});
}

function pickInactivePane(windowTarget) {
	const panes = parsePaneListing(windowTarget);
	const inactive = panes.find((pane) => !pane.active);
	if (!inactive) {
		fail(`expected an inactive pane under ${windowTarget}`);
	}
	return inactive.target;
}

function pickSolePane(windowTarget) {
	const panes = parsePaneListing(windowTarget);
	if (panes.length !== 1) {
		fail(`expected exactly one pane under ${windowTarget}, found ${panes.length}`);
	}
	return panes[0].target;
}

function capturePane(target) {
	try {
		return run("tmux", ["capture-pane", "-p", "-t", target]);
	} catch (error) {
		return `capture failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function createBootstrap(agentId, tmuxMode, tmuxTarget, initialPrompt) {
	return {
		agentId,
		sessionPath: path.join(runtimeDir, `${agentId}.session.jsonl`),
		socketPath: path.join(runtimeDir, `${agentId}.sock`),
		tmuxMode,
		tmuxTarget,
		initialPrompt,
		bootstrapExtensionPath,
		cwd: repoRoot,
		childMode: "interactive-cli",
	};
}

function assertOk(result, label) {
	if (!result?.ok) {
		fail(`${label}: ${result?.error ?? "unknown validation error"}`);
	}
	return result.value;
}

async function waitForOperationalRecord(manager, agentId, timeoutMs) {
	return waitFor(() => {
		const recordResult = manager.getRecord(agentId);
		if (!recordResult.ok) {
			return false;
		}
		const record = recordResult.value;
		if (record.state === "failed" || record.state === "stopped") {
			const reason = record.error?.message ? `: ${record.error.message}` : "";
			fail(`${agentId} entered terminal state ${record.state}${reason}`);
		}
		if (record.degradedAt) {
			fail(`${agentId} degraded before acceptance could complete`);
		}
		return record.connectedAt ? record : false;
	}, timeoutMs, `${agentId} connected`);
}

async function waitForFocusAttached(childPaneTarget, timeoutMs) {
	return waitFor(() => {
		const raw = run("tmux", [
			"display-message",
			"-p",
			"-t",
			childPaneTarget,
			"#{window_name}|#{window_active}|#{pane_active}|#{session_attached}",
		]);
		const [windowName, windowActive, paneActive, sessionAttached] = raw.split("|");
		const attachedCount = Number.parseInt(sessionAttached ?? "0", 10);
		if (windowActive === "1" && paneActive === "1" && Number.isFinite(attachedCount) && attachedCount > 0) {
			return {
				windowName,
				windowActive,
				paneActive,
				sessionAttached: attachedCount,
			};
		}
		return false;
	}, timeoutMs, "focus attach to select the live child pane");
}

async function waitForStaleRecord(manager, agentId, timeoutMs) {
	return waitFor(() => {
		const record = assertOk(manager.getRecord(agentId), `getRecord(${agentId})`);
		if (record.assumptionsStaleAt && record.userIntervenedHistory?.at(-1)?.recordedAt === record.assumptionsStaleAt) {
			return record;
		}
		if (record.state === "failed" || record.state === "stopped") {
			const reason = record.error?.message ? `: ${record.error.message}` : "";
			fail(`${agentId} entered terminal state ${record.state}${reason}`);
		}
		return false;
	}, timeoutMs, `${agentId} assumptionsStaleAt`);
}

async function waitForFreshProgressRecord(manager, agentId, timeoutMs) {
	return waitFor(() => {
		const record = assertOk(manager.getRecord(agentId), `getRecord(${agentId})`);
		if (record.lastProgressReport?.summary === "fresh after intervention" && record.assumptionsStaleAt === undefined) {
			return record;
		}
		if (record.state === "failed" || record.state === "stopped") {
			const reason = record.error?.message ? `: ${record.error.message}` : "";
			fail(`${agentId} entered terminal state ${record.state}${reason}`);
		}
		return false;
	}, timeoutMs, `${agentId} cleared stale marker after explicit child progress`);
}

async function main() {
	log("RAT-131 manual acceptance started");
	log(`focus proof mode: ${runFocusProof ? "in-process" : "external-pty"}`);
	ensureBuiltPiOnPath();
	const tmuxPath = requireExecutable("tmux");
	const scriptPath = requireExecutable("script");
	log(`tmux: ${tmuxPath}`);
	log(`script: ${scriptPath}`);
	assertBuildArtifacts();
	log(`runtimeDir: ${runtimeDir}`);
	log(`logPath: ${logPath}`);

	const {
		NodeSidecarSessionAdapter,
		SubagentManager,
		TmuxSubagentProcessAdapter,
		createRuntimeLaunchSpec,
	} = await import(pathToFileURL(distIndexPath).href);

	const tmuxSessions = [];
	let focusChildPaneTarget;
	let interventionPaneTarget;
	const manager = new SubagentManager({
		sidecarSessions: new NodeSidecarSessionAdapter({
			onEnvelope(direction, message) {
				const line = `${direction}: ${JSON.stringify(message)}`;
				log(line);
			},
		}),
		runtimeProcesses: new TmuxSubagentProcessAdapter({
			exitMarkerDir: runtimeDir,
		}),
	});

	const summary = {
		runId,
		runtimeDir,
		logPath,
		focusProof: {},
		interventionProof: {},
	};

	try {
		if (runFocusProof) {
			const focusAgentId = `rat131_focus_${runId}`;
			const focusSessionName = `${focusAgentId}_tmux`;
			const focusMainWindow = "main";
			const focusChildWindow = "child";
			const focusChildWindowTarget = `${focusSessionName}:${focusChildWindow}`;
			tmuxSessions.push(focusSessionName);

			run("tmux", ["new-session", "-d", "-s", focusSessionName, "-n", focusMainWindow]);
			run("tmux", ["new-window", "-t", focusSessionName, "-n", focusChildWindow]);
			run("tmux", ["split-window", "-t", focusChildWindowTarget, "-h"]);
			run("tmux", ["select-window", "-t", `${focusSessionName}:${focusMainWindow}`]);

			focusChildPaneTarget = pickInactivePane(focusChildWindowTarget);
			const focusBootstrap = createBootstrap(
				focusAgentId,
				"pane",
				focusChildPaneTarget,
				[
					"You are in a runtime acceptance test.",
					"Wait silently for more input.",
					"Do not call report_to_parent.",
					"Do not exit.",
				].join(" "),
			);
			const focusBootstrapPath = path.join(runtimeDir, `${focusAgentId}.bootstrap.json`);
			fs.writeFileSync(focusBootstrapPath, `${JSON.stringify(focusBootstrap, null, 2)}\n`, "utf8");
			const focusLaunchSpec = assertOk(
				createRuntimeLaunchSpec(focusBootstrap, focusBootstrapPath),
				"createRuntimeLaunchSpec(focus)",
			);
			log(`focus resolved command: ${focusLaunchSpec.command}`);

			assertOk(
				manager.spawn({
					type: "acceptance",
					description: "RAT-131 focus proof runtime",
					launchSpec: focusLaunchSpec,
				}),
				"manager.spawn(focus)",
			);
			const focusReadyRecord = await waitForOperationalRecord(manager, focusAgentId, 60_000);
			log(`focus record became operational in state ${focusReadyRecord.state} at ${focusReadyRecord.connectedAt}`);

			const focusTarget = assertOk(manager.getFocusTarget(focusAgentId), "manager.getFocusTarget(focus)");
			log(`focus target: ${JSON.stringify(focusTarget)}`);

			if (focusTarget.availability !== "live") {
				fail(`expected live focus target, received ${focusTarget.availability}`);
			}
			if (focusTarget.tmuxTarget !== focusChildPaneTarget) {
				fail(`focus target mismatch: expected ${focusChildPaneTarget}, received ${focusTarget.tmuxTarget}`);
			}

			const attachProc = spawn(scriptPath, ["-q", "/dev/null", "bash", "-lc", focusTarget.focusCommand], {
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					TERM: process.env.TERM && process.env.TERM !== "dumb" ? process.env.TERM : "xterm-256color",
				},
			});
			const focusAttached = await waitForFocusAttached(focusChildPaneTarget, 20_000);
			log(`focus command attached live child pane: ${JSON.stringify(focusAttached)}`);

			const postFocusRecord = assertOk(manager.getRecord(focusAgentId), "manager.getRecord(focus)");
			if (postFocusRecord.assumptionsStaleAt !== undefined || postFocusRecord.userIntervenedHistory !== undefined) {
				fail("focusing/attaching alone unexpectedly marked the child as user_intervened");
			}

			run("tmux", ["detach-client", "-s", focusSessionName]);
			const attachExit = await waitForProcessExit(attachProc, 20_000, "focus attach command to exit after detach");
			if (attachExit.code !== 0) {
				fail(`focus attach command exited with code ${attachExit.code} signal ${attachExit.signal}`);
			}

			summary.focusProof = {
				agentId: focusAgentId,
				session: focusSessionName,
				childPaneTarget: focusChildPaneTarget,
				focusCommand: focusTarget.focusCommand,
				availability: focusTarget.availability,
				attachedWindowName: focusAttached.windowName,
				sessionAttached: focusAttached.sessionAttached,
				postFocusAssumptionsStaleAt: postFocusRecord.assumptionsStaleAt ?? null,
			};
		} else {
			log("skipping in-process focus proof; execute the returned focusCommand in a real PTY to validate live attach/focus");
			summary.focusProof = {
				skipped: true,
				reason: "requires a real PTY outside the Node child-process harness",
			};
		}

		const interventionAgentId = `rat131_intervention_${runId}`;
		const interventionSessionName = `${interventionAgentId}_tmux`;
		const interventionWindowTarget = `${interventionSessionName}:child`;
		tmuxSessions.push(interventionSessionName);
		run("tmux", ["new-session", "-d", "-s", interventionSessionName, "-n", "child"]);
		interventionPaneTarget = pickSolePane(interventionWindowTarget);

		const interventionBootstrap = createBootstrap(
			interventionAgentId,
			"pane",
			interventionPaneTarget,
			[
				"You are in a tmux-backed runtime acceptance test.",
				"Do not call report_to_parent until the parent explicitly asks in a follow-up.",
				"If the user types directly to you, do not use report_to_parent for that direct message.",
				"Wait for more input.",
			].join(" "),
		);
		const interventionBootstrapPath = path.join(runtimeDir, `${interventionAgentId}.bootstrap.json`);
		fs.writeFileSync(interventionBootstrapPath, `${JSON.stringify(interventionBootstrap, null, 2)}\n`, "utf8");
		const interventionLaunchSpec = assertOk(
			createRuntimeLaunchSpec(interventionBootstrap, interventionBootstrapPath),
			"createRuntimeLaunchSpec(intervention)",
		);
		log(`intervention resolved command: ${interventionLaunchSpec.command}`);

		assertOk(
			manager.spawn({
				type: "acceptance",
				description: "RAT-131 intervention proof runtime",
				launchSpec: interventionLaunchSpec,
			}),
			"manager.spawn(intervention)",
		);
		const interventionReadyRecord = await waitForOperationalRecord(manager, interventionAgentId, 60_000);
		log(`intervention record became operational in state ${interventionReadyRecord.state} at ${interventionReadyRecord.connectedAt}`);
		await sleep(1_500);

		const preInterventionRecord = assertOk(manager.getRecord(interventionAgentId), "manager.getRecord(preIntervention)");
		if (preInterventionRecord.assumptionsStaleAt !== undefined) {
			fail("intervention proof started with assumptionsStaleAt already set");
		}

		run("tmux", [
			"send-keys",
			"-t",
			interventionPaneTarget,
			"-l",
			"Direct user message from tmux. Do not call report_to_parent. Wait for the parent's follow-up.",
		]);
		run("tmux", ["send-keys", "-t", interventionPaneTarget, "Enter"]);

		const staleRecord = await waitForStaleRecord(manager, interventionAgentId, 60_000);
		log(`observed assumptionsStaleAt=${staleRecord.assumptionsStaleAt}`);

		assertOk(
			manager.sendFollowUp(
				interventionAgentId,
				"Call report_to_parent exactly once with kind progress and summary exactly 'fresh after intervention'. Do not ask questions.",
			),
			"manager.sendFollowUp(intervention)",
		);

		const postFollowUpRecord = assertOk(manager.getRecord(interventionAgentId), "manager.getRecord(postFollowUp)");
		if (postFollowUpRecord.assumptionsStaleAt !== staleRecord.assumptionsStaleAt) {
			fail("parent follow_up cleared assumptionsStaleAt before a newer explicit child-authored report arrived");
		}

		const freshRecord = await waitForFreshProgressRecord(manager, interventionAgentId, 120_000);
		log(`fresh progress observed at ${freshRecord.lastProgressReport?.reportedAt}`);

		if (!freshRecord.lastProgressReport?.reportedAt || !staleRecord.assumptionsStaleAt) {
			fail("fresh progress proof did not retain the required timestamps");
		}
		if (freshRecord.lastProgressReport.reportedAt <= staleRecord.assumptionsStaleAt) {
			fail("fresh progress did not arrive after assumptionsStaleAt");
		}

		summary.interventionProof = {
			agentId: interventionAgentId,
			session: interventionSessionName,
			paneTarget: interventionPaneTarget,
			assumptionsStaleAt: staleRecord.assumptionsStaleAt,
			interventionCount: staleRecord.userIntervenedHistory?.length ?? 0,
			postFollowUpAssumptionsStaleAt: postFollowUpRecord.assumptionsStaleAt,
			clearedOnProgressSummary: freshRecord.lastProgressReport.summary,
			progressReportedAt: freshRecord.lastProgressReport.reportedAt,
		};

		fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
		log(`PASS: real focus flow and direct-user-intervention stale/fresh flow verified`);
		log(`saved summary to ${summaryPath}`);
		log(`saved acceptance log to ${logPath}`);
	} catch (error) {
		if (focusChildPaneTarget) {
			log(`focus pane snapshot:\n${capturePane(focusChildPaneTarget)}`);
		}
		if (interventionPaneTarget) {
			log(`intervention pane snapshot:\n${capturePane(interventionPaneTarget)}`);
		}
		throw error;
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
	const reason = error instanceof Error ? error.stack ?? error.message : String(error);
	log(`fatal: ${reason}`);
	process.exitCode = 1;
});
