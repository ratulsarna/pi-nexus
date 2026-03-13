import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Type, type Static, type TSchema } from "@sinclair/typebox";

import {
	loadAgentDefinitionRegistry,
	prepareNamedSubagentSpawn,
	type AgentDefinitionRegistry,
	type ResolvedAgentDefinition,
} from "./agent-definitions.js";
import type {
	RuntimeLaunchSpec,
	SidecarEventMessage,
	SubagentRecord,
	SubagentFocusTarget,
	TmuxMode,
	ValidationError,
	ValidationOutcome,
	ValidationResult,
} from "./contracts.js";
import { NodeSidecarSessionAdapter, TmuxSubagentProcessAdapter } from "./node-runtime-adapters.js";
import { SubagentManager, type SidecarSessionAdapter, type SubagentProcessAdapter } from "./subagent-manager.js";

interface ReadonlySessionManagerLike {
	getSessionFile(): string;
}

interface ExtensionUiLike {
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

interface ExtensionContextLike {
	cwd: string;
	hasUI: boolean;
	isIdle(): boolean;
	sessionManager: ReadonlySessionManagerLike;
	ui: ExtensionUiLike;
}

interface ExtensionCommandContextLike extends ExtensionContextLike {
	waitForIdle(): Promise<void>;
}

interface AutocompleteItemLike {
	label: string;
	value: string;
}

interface RegisteredCommandLike {
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItemLike[] | null;
	handler: (args: string, ctx: ExtensionCommandContextLike) => Promise<void>;
}

interface CustomMessageLike<T = unknown> {
	customType: string;
	content: string;
	display?: boolean;
	details?: T;
}

interface ToolTextContent {
	type: "text";
	text: string;
}

interface ToolResultLike<TDetails = unknown> {
	content: ToolTextContent[];
	details?: TDetails;
}

interface ToolDefinitionLike<TParams extends TSchema = TSchema, TDetails = unknown> {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: TParams;
	execute: (
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: ExtensionContextLike,
	) => Promise<ToolResultLike<TDetails>>;
}

interface ExtensionApiLike {
	on(
		event: "session_start" | "session_shutdown" | "agent_start" | "agent_end",
		handler: (event: unknown, ctx: ExtensionContextLike) => unknown | Promise<unknown>,
	): void;
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(
		tool: ToolDefinitionLike<TParams, TDetails>,
	): void;
	registerCommand(name: string, options: RegisteredCommandLike): void;
	sendMessage<T = unknown>(
		message: Pick<CustomMessageLike<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	sendUserMessage(
		content: string | Array<{ type: "text"; text: string }>,
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
}

interface OwnedTmuxRuntime {
	sessionName: string;
	tmuxMode: TmuxMode;
	tmuxTarget: string;
}

interface ParentSessionState<TData = unknown> {
	sessionFile: string;
	cwd: string;
	homeDir: string;
	sessionDir: string;
	manager: SubagentManager<TData>;
	registry?: AgentDefinitionRegistry;
	busy: boolean;
	nextAgentOrdinal: number;
	ownedTmuxRuntimes: Map<string, OwnedTmuxRuntime>;
}

export interface ParentExtensionOptions<TData = unknown> {
	bootstrapExtensionPath?: string;
	homeDir?: string;
	now?: () => string;
	runTmuxCommand?: (args: string[]) => ValidationOutcome<string>;
	sidecarSessions?: SidecarSessionAdapter<TData>;
	runtimeProcesses?: SubagentProcessAdapter;
}

interface TmuxSpawnTarget {
	sessionName: string;
	tmuxTarget: string;
	tmuxMode: TmuxMode;
}

interface SpawnToolDetails {
	agentId: string;
	state: string;
	subagentType: string;
	displayName: string;
	focusAvailability: string;
}

const AGENT_TOOL_PARAMETERS = Type.Object({
	prompt: Type.String({
		description: "The task for the subagent to perform.",
	}),
	description: Type.String({
		description: "A short description for the spawned subagent.",
	}),
	subagent_type: Type.String({
		description: "Named subagent type to use, such as general-purpose, Explore, or Plan.",
	}),
	tmux_mode: Type.Optional(
		Type.Union([Type.Literal("window"), Type.Literal("pane")], {
			description: "Tmux focus target type. Defaults to window.",
		}),
	),
});

function fail(error: string): ValidationError {
	return { ok: false, error };
}

function ok<T>(value: T): ValidationResult<T> {
	return { ok: true, value };
}

function normalizeError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	return new Error(String(error));
}

function textResult<TDetails = unknown>(text: string, details?: TDetails): ToolResultLike<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function sanitizeNameSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "session";
}

function createSessionKey(sessionFile: string): string {
	const baseName = sanitizeNameSegment(path.basename(sessionFile, path.extname(sessionFile))).slice(0, 24) || "session";
	const hash = createHash("sha1").update(sessionFile).digest("hex").slice(0, 10);
	return `${baseName}-${hash}`;
}

function resolveDefaultBootstrapExtensionPath(): string {
	const currentPath = fileURLToPath(import.meta.url);
	const extension = path.extname(currentPath);
	return path.join(path.dirname(currentPath), `subagent-bootstrap-extension${extension}`);
}

function trimCommandOutput(output: string | Buffer | null | undefined): string {
	if (typeof output === "string") {
		return output.trim();
	}

	if (output instanceof Buffer) {
		return output.toString("utf8").trim();
	}

	return "";
}

export function createTmuxCommandRunner(
	spawnSyncImpl: typeof childProcess.spawnSync = childProcess.spawnSync,
): (args: string[]) => ValidationOutcome<string> {
	return (args: string[]): ValidationOutcome<string> => {
		const result = spawnSyncImpl("tmux", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stderr = trimCommandOutput(result.stderr);
		const stdout = trimCommandOutput(result.stdout);
		if (result.status !== 0) {
			const spawnError = result.error ? normalizeError(result.error).message : "";
			return fail(
				stderr.length > 0
					? `tmux ${args.join(" ")} failed: ${stderr}`
					: stdout.length > 0
						? `tmux ${args.join(" ")} failed: ${stdout}`
						: spawnError.length > 0
							? `tmux ${args.join(" ")} failed: ${spawnError}`
							: `tmux ${args.join(" ")} failed`,
			);
		}

		return ok(stdout);
	};
}

function ensureDirectory(directoryPath: string): void {
	fs.mkdirSync(directoryPath, { recursive: true });
}

function renderDataBlock(data: unknown): string {
	if (data === null || data === undefined) {
		return "";
	}

	try {
		return `\nData:\n${JSON.stringify(data, null, 2)}`;
	} catch (error) {
		return `\nData:\n${normalizeError(error).message}`;
	}
}

function formatDisplayName(definition: ResolvedAgentDefinition | undefined, record: Pick<SubagentRecord, "type">): string {
	return definition?.displayName?.trim() || definition?.name || record.type;
}

function formatSubagentLabel(definition: ResolvedAgentDefinition | undefined, record: Pick<SubagentRecord, "id" | "type" | "description">): string {
	const displayName = formatDisplayName(definition, record);
	return `${displayName} (${record.type}) [${record.id}]`;
}

function sendSessionMessage(
	pi: ExtensionApiLike,
	customType: string,
	content: string,
	details?: Record<string, unknown>,
): void {
	pi.sendMessage(
		{
			customType,
			content,
			display: true,
			details,
		},
		{ triggerTurn: false },
	);
}

function deliverChildFollowUp(
	pi: ExtensionApiLike,
	state: ParentSessionState,
	content: string,
): void {
	if (state.busy) {
		pi.sendUserMessage(content, { deliverAs: "followUp" });
		return;
	}

	pi.sendUserMessage(content);
}

function refreshRegistry(state: ParentSessionState): ValidationOutcome<AgentDefinitionRegistry> {
	if (!state.registry) {
		const loadResult = loadAgentDefinitionRegistry({
			cwd: state.cwd,
			homeDir: state.homeDir,
		});
		if (!loadResult.ok) return loadResult;
		state.registry = loadResult.value;
		return ok(loadResult.value);
	}

	const refreshResult = state.registry.refresh();
	if (!refreshResult.ok) return refreshResult;
	return ok(state.registry);
}

function resolveDefinitionForRecord(
	state: ParentSessionState,
	record: Pick<SubagentRecord, "type">,
): ResolvedAgentDefinition | undefined {
	const registryResult = refreshRegistry(state);
	if (!registryResult.ok) {
		return undefined;
	}

	const definitionResult = registryResult.value.resolve(record.type);
	return definitionResult.ok ? definitionResult.value : undefined;
}

function bridgeAcceptedEvent(
	pi: ExtensionApiLike,
	state: ParentSessionState,
	agentId: string,
	event: SidecarEventMessage,
	record: SubagentRecord,
): void {
	const definition = resolveDefinitionForRecord(state, record);
	const label = formatSubagentLabel(definition, record);

	switch (event.type) {
		case "progress":
			sendSessionMessage(
				pi,
				"pi-nexus-subagent-progress",
				`Subagent progress from ${label}\n\n${event.payload.summary}`,
				{
					agentId,
					type: record.type,
					state: record.state,
				},
			);
			return;
		case "final_result":
			deliverChildFollowUp(
				pi,
				state,
				[
					`Subagent final_result from ${label}.`,
					`Summary: ${event.payload.summary}`,
					renderDataBlock(event.payload.data),
				].join("\n").trim(),
			);
			return;
		case "needs_input":
			deliverChildFollowUp(
				pi,
				state,
				`Subagent needs_input from ${label}.\nQuestion: ${event.payload.question}`,
			);
			return;
		case "error":
			deliverChildFollowUp(
				pi,
				state,
				`Subagent error from ${label}.\nFatal: ${event.payload.fatal ? "yes" : "no"}\nMessage: ${event.payload.message}`,
			);
			return;
		case "user_intervened":
			sendSessionMessage(
				pi,
				"pi-nexus-subagent-status",
				`Subagent assumptions are stale for ${label} after direct tmux intervention. Waiting for the next explicit child-authored report.`,
				{
					agentId,
					assumptionsStaleAt: record.assumptionsStaleAt,
				},
			);
			return;
		case "ready":
		case "state":
		case "pong":
			return;
	}
}

function createParentSessionState(
	pi: ExtensionApiLike,
	sessionFile: string,
	cwd: string,
	options: Required<Pick<ParentExtensionOptions, "homeDir" | "now" | "runTmuxCommand">> & {
		sidecarSessions: SidecarSessionAdapter;
		runtimeProcesses: SubagentProcessAdapter;
	},
): ValidationOutcome<ParentSessionState> {
	const sessionKey = createSessionKey(sessionFile);
	const sessionDir = path.join(options.homeDir, ".ai", "pi-nexus", sessionKey);
	try {
		ensureDirectory(sessionDir);
	} catch (error) {
		return fail(`failed to prepare parent session runtime directory: ${normalizeError(error).message}`);
	}

	const state: ParentSessionState = {
		sessionFile,
		cwd,
		homeDir: options.homeDir,
		sessionDir,
		manager: undefined as unknown as SubagentManager,
		busy: false,
		nextAgentOrdinal: 0,
		ownedTmuxRuntimes: new Map<string, OwnedTmuxRuntime>(),
	};

	state.manager = new SubagentManager({
		now: options.now,
		sidecarSessions: options.sidecarSessions,
		runtimeProcesses: options.runtimeProcesses,
		onEventAccepted(agentId, event, record) {
			bridgeAcceptedEvent(pi, state, agentId, event, record);
		},
	});

	return ok(state);
}

function ensureCurrentState(
	pi: ExtensionApiLike,
	currentState: ParentSessionState | undefined,
	ctx: ExtensionContextLike,
	options: Required<Pick<ParentExtensionOptions, "homeDir" | "now" | "runTmuxCommand">> & {
		sidecarSessions: SidecarSessionAdapter;
		runtimeProcesses: SubagentProcessAdapter;
	},
): ValidationOutcome<ParentSessionState> {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (currentState && currentState.sessionFile === sessionFile) {
		currentState.cwd = ctx.cwd;
		currentState.busy = !ctx.isIdle();
		return ok(currentState);
	}

	return createParentSessionState(pi, sessionFile, ctx.cwd, options);
}

function allocateTmuxTarget(
	state: ParentSessionState,
	tmuxMode: TmuxMode,
	now: () => string,
	runTmuxCommand: (args: string[]) => ValidationOutcome<string>,
): ValidationOutcome<TmuxSpawnTarget> {
	const timestampKey = now().replace(/[-:.TZ]/g, "").slice(0, 14) || Date.now().toString(36);
	const sessionName = sanitizeNameSegment(
		`pnx_${createSessionKey(state.sessionFile).slice(0, 18)}_${timestampKey}_${String(state.nextAgentOrdinal).padStart(2, "0")}`,
	).slice(0, 48);
	const newSessionResult = runTmuxCommand(["new-session", "-d", "-s", sessionName, "-n", "child"]);
	if (!newSessionResult.ok) {
		return fail(newSessionResult.error);
	}

	const windowTarget = `${sessionName}:child`;
	if (tmuxMode === "window") {
		return ok({
			sessionName,
			tmuxTarget: windowTarget,
			tmuxMode,
		});
	}

	const panesResult = runTmuxCommand(["list-panes", "-t", windowTarget, "-F", "#{session_name}:#{window_name}.#{pane_index}"]);
	if (!panesResult.ok) {
		killTmuxSession(runTmuxCommand, sessionName);
		return panesResult;
	}
	const panes = panesResult.value
		.split("\n")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (panes.length !== 1) {
		killTmuxSession(runTmuxCommand, sessionName);
		return fail(`expected exactly one pane for ${windowTarget}, found ${panes.length}`);
	}

	return ok({
		sessionName,
		tmuxTarget: panes[0],
		tmuxMode,
	});
}

function killTmuxSession(
	runTmuxCommand: (args: string[]) => ValidationOutcome<string>,
	sessionName: string,
): void {
	runTmuxCommand(["kill-session", "-t", sessionName]);
}

function buildSpawnText(
	record: SubagentRecord,
	definition: ResolvedAgentDefinition,
	focusTarget: SubagentFocusTarget | undefined,
): string {
	const displayName = formatDisplayName(definition, record);
	return [
		`Spawned subagent ${record.id}.`,
		`Type: ${displayName} (${record.type})`,
		`State: ${record.state}`,
		`Focus availability: ${focusTarget?.availability ?? "unknown"}`,
		`Use /subagents list or /subagents focus ${record.id} for the live tmux target.`,
	].join("\n");
}

function formatListText(
	state: ParentSessionState,
): string {
	const records = state.manager.listRecords();
	if (records.length === 0) {
		return "No subagents are currently managed in this Pi session.";
	}

	const lines = records.map((record) => {
		const definition = resolveDefinitionForRecord(state, record);
		const displayName = formatDisplayName(definition, record);
		const focusResult = state.manager.getFocusTarget(record.id);
		const focusAvailability = focusResult.ok ? focusResult.value.availability : "unknown";
		const markers = [
			record.assumptionsStaleAt ? `stale@${record.assumptionsStaleAt}` : undefined,
			record.degradedAt ? `degraded@${record.degradedAt}` : undefined,
			record.error ? "error" : undefined,
		].filter((entry): entry is string => entry !== undefined);

		return `- ${record.id} | ${displayName} (${record.type}) | posture=${record.state} | focus=${focusAvailability} | markers=${markers.join(", ") || "none"}`;
	});

	return ["Managed subagents:", ...lines].join("\n");
}

function formatFocusText(
	record: SubagentRecord,
	definition: ResolvedAgentDefinition | undefined,
	focusTarget: SubagentFocusTarget,
): string {
	const displayName = formatDisplayName(definition, record);
	return [
		`Subagent focus target for ${record.id}`,
		`Type: ${displayName} (${record.type})`,
		`State: ${record.state}`,
		`Availability: ${focusTarget.availability}`,
		`Tmux mode: ${focusTarget.tmuxMode}`,
		`Tmux target: ${focusTarget.tmuxTarget}`,
		`Session path: ${focusTarget.sessionPath}`,
		`Focus command: ${focusTarget.focusCommand}`,
		focusTarget.note ? `Note: ${focusTarget.note}` : undefined,
	].filter((entry): entry is string => entry !== undefined).join("\n");
}

function shutdownParentSession(
	state: ParentSessionState | undefined,
	runTmuxCommand: (args: string[]) => ValidationOutcome<string>,
): void {
	if (!state) {
		return;
	}

	state.manager.shutdownAll();
	for (const runtime of state.ownedTmuxRuntimes.values()) {
		killTmuxSession(runTmuxCommand, runtime.sessionName);
	}
	state.ownedTmuxRuntimes.clear();
}

function notifyRuntimePreparationFailure(ctx: ExtensionContextLike, error: string): void {
	ctx.ui.notify(`pi-nexus parent session setup failed: ${error}`, "error");
}

export function installParentExtension(
	pi: ExtensionApiLike,
	options: ParentExtensionOptions = {},
): void {
	const effectiveOptions = {
		bootstrapExtensionPath: options.bootstrapExtensionPath ?? resolveDefaultBootstrapExtensionPath(),
		homeDir: options.homeDir ?? os.homedir(),
		now: options.now ?? (() => new Date().toISOString()),
		runTmuxCommand: options.runTmuxCommand ?? createTmuxCommandRunner(),
		sidecarSessions: options.sidecarSessions ?? new NodeSidecarSessionAdapter(),
		runtimeProcesses: options.runtimeProcesses ?? new TmuxSubagentProcessAdapter(),
	};

	let activeState: ParentSessionState | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (activeState && activeState.sessionFile !== ctx.sessionManager.getSessionFile()) {
			shutdownParentSession(activeState, effectiveOptions.runTmuxCommand);
		}
		const stateResult = ensureCurrentState(pi, activeState, ctx, effectiveOptions);
		if (!stateResult.ok) {
			activeState = undefined;
			notifyRuntimePreparationFailure(ctx, stateResult.error);
			return;
		}
		activeState = stateResult.value;
	});

	pi.on("agent_start", async (_event, ctx) => {
		const stateResult = ensureCurrentState(pi, activeState, ctx, effectiveOptions);
		if (!stateResult.ok) {
			activeState = undefined;
			notifyRuntimePreparationFailure(ctx, stateResult.error);
			return;
		}
		activeState = stateResult.value;
		activeState.busy = true;
	});

	pi.on("agent_end", async (_event, ctx) => {
		const stateResult = ensureCurrentState(pi, activeState, ctx, effectiveOptions);
		if (!stateResult.ok) {
			activeState = undefined;
			notifyRuntimePreparationFailure(ctx, stateResult.error);
			return;
		}
		activeState = stateResult.value;
		activeState.busy = false;
	});

	pi.on("session_shutdown", async () => {
		shutdownParentSession(activeState, effectiveOptions.runTmuxCommand);
		activeState = undefined;
	});

	pi.registerTool<typeof AGENT_TOOL_PARAMETERS, SpawnToolDetails>({
		name: "Agent",
		label: "Agent",
		description: "Spawn a named tmux-backed subagent through pi-nexus.",
		promptSnippet: "Spawn a named tmux-backed subagent via pi-nexus.",
		promptGuidelines: [
			"Use named types like general-purpose, Explore, or Plan.",
			"After spawning, use /subagents list or /subagents focus <id> for live tmux targets.",
		],
		parameters: AGENT_TOOL_PARAMETERS,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const stateResult = ensureCurrentState(pi, activeState, ctx, effectiveOptions);
			if (!stateResult.ok) {
				activeState = undefined;
				return textResult(`Failed to prepare parent session runtime: ${stateResult.error}`);
			}
			activeState = stateResult.value;
			const state = activeState;
			const registryResult = refreshRegistry(state);
			if (!registryResult.ok) {
				return textResult(`Failed to load agent definitions: ${registryResult.error}`);
			}

			state.nextAgentOrdinal += 1;
			const agentId = `agt_${String(state.nextAgentOrdinal).padStart(3, "0")}_${Date.now().toString(36)}`;
			const tmuxMode = params.tmux_mode ?? "window";
			const tmuxTargetResult = allocateTmuxTarget(state, tmuxMode, effectiveOptions.now, effectiveOptions.runTmuxCommand);
			if (!tmuxTargetResult.ok) {
				return textResult(`Failed to provision tmux target: ${tmuxTargetResult.error}`);
			}

			const tmuxTarget = tmuxTargetResult.value;
			const agentDir = path.join(state.sessionDir, agentId);
			try {
				ensureDirectory(agentDir);
			} catch (error) {
				killTmuxSession(effectiveOptions.runTmuxCommand, tmuxTarget.sessionName);
				return textResult(`Failed to prepare agent runtime directory: ${normalizeError(error).message}`);
			}

			const preparedResult = prepareNamedSubagentSpawn({
				registry: registryResult.value,
				type: params.subagent_type,
				description: params.description,
				taskPrompt: params.prompt,
				agentId,
				sessionPath: path.join(agentDir, "session.jsonl"),
				socketPath: path.join(agentDir, "sidecar.sock"),
				tmuxMode: tmuxTarget.tmuxMode,
				tmuxTarget: tmuxTarget.tmuxTarget,
				bootstrapConfigPath: path.join(agentDir, "bootstrap.json"),
				bootstrapExtensionPath: effectiveOptions.bootstrapExtensionPath,
				cwd: state.cwd,
			});
			if (!preparedResult.ok) {
				killTmuxSession(effectiveOptions.runTmuxCommand, tmuxTarget.sessionName);
				return textResult(`Failed to prepare named subagent spawn: ${preparedResult.error}`);
			}

			const spawnResult = state.manager.spawn(preparedResult.value.request);
			if (!spawnResult.ok) {
				killTmuxSession(effectiveOptions.runTmuxCommand, tmuxTarget.sessionName);
				return textResult(`Failed to spawn subagent: ${spawnResult.error}`);
			}

			state.ownedTmuxRuntimes.set(agentId, {
				sessionName: tmuxTarget.sessionName,
				tmuxMode: tmuxTarget.tmuxMode,
				tmuxTarget: tmuxTarget.tmuxTarget,
			});

			const focusResult = state.manager.getFocusTarget(agentId);
			return textResult(
				buildSpawnText(
					spawnResult.value,
					preparedResult.value.definition,
					focusResult.ok ? focusResult.value : undefined,
				),
				{
					agentId,
					state: spawnResult.value.state,
					subagentType: preparedResult.value.definition.name,
					displayName: formatDisplayName(preparedResult.value.definition, spawnResult.value),
					focusAvailability: focusResult.ok ? focusResult.value.availability : "unknown",
				},
			);
		},
	});

	pi.registerCommand("subagents", {
		description: "List subagents or print the exact tmux focus command for one.",
		getArgumentCompletions: (argumentPrefix) => {
			const trimmed = argumentPrefix.trimStart();
			if (trimmed.length === 0) {
				return [
					{ value: "list", label: "list" },
					{ value: "focus ", label: "focus <agentId>" },
				];
			}

			if (trimmed.startsWith("focus ")) {
				const focusPrefix = trimmed.slice("focus ".length);
				const items = activeState?.manager.listRecords() ?? [];
				return items
					.filter((record) => record.id.startsWith(focusPrefix))
					.map((record) => ({
						value: `focus ${record.id}`,
						label: record.id,
					}));
			}

			const commands = ["list", "focus"];
			return commands
				.filter((entry) => entry.startsWith(trimmed))
				.map((entry) => ({ value: entry, label: entry }));
		},
		handler: async (args, ctx) => {
			const stateResult = ensureCurrentState(pi, activeState, ctx, effectiveOptions);
			if (!stateResult.ok) {
				activeState = undefined;
				sendSessionMessage(
					pi,
					"pi-nexus-subagents-output",
					`Failed to prepare parent session runtime: ${stateResult.error}`,
					{ command: "subagents" },
				);
				return;
			}
			activeState = stateResult.value;
			const state = activeState;
			const trimmed = args.trim();
			const [command, ...rest] = trimmed.split(/\s+/).filter((entry) => entry.length > 0);

			if (!command || command === "list") {
				sendSessionMessage(pi, "pi-nexus-subagents-output", formatListText(state), {
					command: "list",
				});
				return;
			}

			if (command === "focus") {
				const agentId = rest.join(" ").trim();
				if (!agentId) {
					sendSessionMessage(
						pi,
						"pi-nexus-subagents-output",
						"Usage: /subagents focus <agentId>",
						{ command: "focus" },
					);
					return;
				}

				const recordResult = state.manager.getRecord(agentId);
				if (!recordResult.ok) {
					sendSessionMessage(
						pi,
						"pi-nexus-subagents-output",
						`Unknown managed agent: ${agentId}`,
						{ command: "focus", agentId },
					);
					return;
				}

				const focusResult = state.manager.getFocusTarget(agentId);
				if (!focusResult.ok) {
					sendSessionMessage(
						pi,
						"pi-nexus-subagents-output",
						`Failed to build focus target for ${agentId}: ${focusResult.error}`,
						{ command: "focus", agentId },
					);
					return;
				}

				const definition = resolveDefinitionForRecord(state, recordResult.value);
				sendSessionMessage(
					pi,
					"pi-nexus-subagents-output",
					formatFocusText(recordResult.value, definition, focusResult.value),
					{ command: "focus", agentId },
				);
				return;
			}

			sendSessionMessage(
				pi,
				"pi-nexus-subagents-output",
				"Usage:\n/subagents list\n/subagents focus <agentId>",
				{ command: "usage" },
			);
		},
	});
}

export default function parentExtension(pi: ExtensionApiLike): void {
	installParentExtension(pi);
}
