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
	SubagentOpenMode,
	SubagentUiSnapshot,
	SubagentUiStateSnapshot,
	TmuxMode,
	ValidationError,
	ValidationOutcome,
	ValidationResult,
} from "./contracts.js";
import {
	validateSubagentOpenMode,
	validateSubagentUiSnapshot,
	validateSubagentUiStateSnapshot,
} from "./contracts.js";
import { NodeSidecarSessionAdapter, TmuxSubagentProcessAdapter } from "./node-runtime-adapters.js";
import { SubagentManager, type SidecarSessionAdapter, type SubagentProcessAdapter } from "./subagent-manager.js";

interface ReadonlySessionManagerLike {
	getSessionFile(): string;
	getEntries(): Array<{
		type: string;
		customType?: string;
		data?: unknown;
	}>;
}

interface ExtensionUiLike {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	onTerminalInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	setWidget?(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	custom?<T>(
		factory: (
			tui: { requestRender(full?: boolean): void; stop?(): void; start?(): void },
			theme: unknown,
			keybindings: unknown,
			done: (result: T) => void,
		) => {
			render(width: number): string[];
			handleInput?(data: string): void;
			invalidate(): void;
			dispose?(): void;
			focused?: boolean;
		},
		options?: {
			overlay?: boolean;
			screen?: boolean;
			overlayOptions?: {
				width?: number | `${number}%`;
				maxHeight?: number | `${number}%`;
				anchor?: string;
			};
		},
	): Promise<T>;
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

interface MessageRendererLike {
	render(width: number): string[];
}

type MessageRendererFactoryLike = (
	message: CustomMessageLike,
	options: { expanded?: boolean },
	theme: unknown,
) => MessageRendererLike | undefined;

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
	registerMessageRenderer(customType: string, renderer: MessageRendererFactoryLike): void;
	sendMessage<T = unknown>(
		message: Pick<CustomMessageLike<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	sendUserMessage(
		content: string | Array<{ type: "text"; text: string }>,
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
	appendEntry<T = unknown>(customType: string, data?: T): void;
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
	now: () => string;
	manager: SubagentManager<TData>;
	registry?: AgentDefinitionRegistry;
	busy: boolean;
	nextAgentOrdinal: number;
	ownedTmuxRuntimes: Map<string, OwnedTmuxRuntime>;
	uiState: SubagentUiStateSnapshot;
	lastUiContext?: ExtensionContextLike;
	terminalInputUnsubscribe?: () => void;
	widgetRefreshInterval?: ReturnType<typeof setInterval>;
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

type EffectiveParentExtensionOptions = Required<ParentExtensionOptions>;

interface SubagentToolDetails {
	action: "spawn" | "list" | "send" | "interrupt" | "open" | "focus";
	agentId?: string;
	state?: string;
	subagentType?: string;
	displayName?: string;
	openAvailability?: string;
	mode?: SubagentOpenMode;
}

const UI_STATE_CUSTOM_TYPE = "pi-nexus-ui-state";
const UI_WIDGET_KEY = "pi-nexus-subagents";
const LEGACY_FOCUS_MESSAGE = [
	"action=focus has been removed.",
	"Use action=open with mode=peek, follow, or take_over.",
	"Use /subagents open <agentId> [peek|follow|take_over] from the TUI.",
].join(" ");

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

const SUBAGENT_TOOL_PARAMETERS = Type.Object({
	action: Type.Union([
		Type.Literal("spawn"),
		Type.Literal("list"),
		Type.Literal("send"),
		Type.Literal("interrupt"),
		Type.Literal("open"),
		Type.Literal("focus"),
	], {
		description: "Subagent action to perform.",
	}),
	agent_id: Type.Optional(Type.String({
		description: "Managed subagent id for send, interrupt, or open actions.",
	})),
	mode: Type.Optional(
		Type.Union([Type.Literal("peek"), Type.Literal("follow"), Type.Literal("take_over")], {
			description: "Open mode for the open action. Defaults to peek.",
		}),
	),
	message: Type.Optional(Type.String({
		description: "Follow-up message for the send action.",
	})),
	prompt: Type.Optional(Type.String({
		description: "The task for the spawned subagent when action is spawn.",
	})),
	description: Type.Optional(Type.String({
		description: "A short description for the spawned subagent when action is spawn.",
	})),
	subagent_type: Type.Optional(Type.String({
		description: "Named subagent type to use when action is spawn, such as general-purpose, Explore, or Plan.",
	})),
	tmux_mode: Type.Optional(
		Type.Union([Type.Literal("window"), Type.Literal("pane")], {
			description: "Tmux focus target type for spawn. Defaults to window.",
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

function normalizeSummary(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function deriveUiAvailability(record: SubagentRecord): "live" | "degraded" | "history" {
	if (record.state === "failed" || record.state === "stopped") {
		return "history";
	}
	if (record.degradedAt) {
		return "degraded";
	}
	return "live";
}

function deriveUiNote(record: SubagentRecord): string | undefined {
	if (record.state === "failed") {
		return "Child session failed. Historical detail is still available.";
	}
	if (record.state === "stopped") {
		return "Child session stopped. Historical detail is still available.";
	}
	if (record.degradedAt) {
		return "Sidecar trust is degraded. Observation and direct takeover are still available while tmux stays live.";
	}
	return undefined;
}

function buildSubagentUiSnapshot(
	record: SubagentRecord,
	definition: ResolvedAgentDefinition | undefined,
): ValidationOutcome<SubagentUiSnapshot> {
	const availability = deriveUiAvailability(record);
	const endedAt = record.state === "failed"
		? record.error?.recordedAt ?? record.stoppedAt
		: record.state === "stopped"
			? record.stoppedAt ?? record.error?.recordedAt
			: undefined;
	return validateSubagentUiSnapshot({
		agentId: record.id,
		displayName: formatDisplayName(definition, record),
		type: record.type,
		description: record.description,
		state: record.state,
		availability,
		tmuxMode: record.tmuxMode,
		tmuxTarget: record.tmuxTarget,
		sessionPath: record.sessionPath,
		startedAt: record.startedAt,
		endedAt,
		latestSummary: normalizeSummary(record.lastProgressReport?.summary),
		pendingInputQuestion: normalizeSummary(record.pendingInputRequest?.summary),
		finalSummary: normalizeSummary(record.finalResult?.summary),
		errorMessage: normalizeSummary(record.error?.message),
		note: deriveUiNote(record),
		isStale: record.assumptionsStaleAt !== undefined,
		isDegraded: record.degradedAt !== undefined,
		isHistorical: availability === "history",
		canOpenPeek: true,
		canOpenFollow: availability !== "history",
		canOpenTakeOver: availability !== "history",
		canSend: availability !== "history" && record.degradedAt === undefined,
		canInterrupt: availability !== "history" && record.degradedAt === undefined,
	});
}

function createEmptyUiState(updatedAt: string): SubagentUiStateSnapshot {
	return {
		version: 1,
		updatedAt,
		agents: [],
	};
}

function restoreUiStateFromEntries(
	entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
	now: () => string,
): SubagentUiStateSnapshot {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== UI_STATE_CUSTOM_TYPE) {
			continue;
		}
		const snapshotResult = validateSubagentUiStateSnapshot(entry.data);
		if (snapshotResult.ok) {
			return snapshotResult.value;
		}
	}

	return createEmptyUiState(now());
}

function sortUiSnapshots(snapshots: ReadonlyArray<SubagentUiSnapshot>): SubagentUiSnapshot[] {
	return [...snapshots].sort((left, right) => {
		if (left.isHistorical !== right.isHistorical) {
			return left.isHistorical ? 1 : -1;
		}
		if (left.displayName !== right.displayName) {
			return left.displayName.localeCompare(right.displayName);
		}
		return left.agentId.localeCompare(right.agentId);
	});
}

function formatWidgetLines(uiState: SubagentUiStateSnapshot): string[] {
	const live = uiState.agents.filter((snapshot) => !snapshot.isHistorical);
	const history = uiState.agents.filter((snapshot) => snapshot.isHistorical);
	const lines = [
		`Subagents  live=${live.length} history=${history.length}`,
		"  Open /subagents or Alt+A",
	];

	if (live.length === 0 && history.length === 0) {
		lines.push("  none");
		return lines;
	}

	if (live.length > 0) {
		lines.push("  Live");
		for (const snapshot of live) {
			lines.push(`  ${formatWidgetRow(snapshot, uiState.updatedAt)}`);
			const summary = summarizeWidgetSnapshot(snapshot);
			if (summary) {
				lines.push(`    ${summary}`);
			}
		}
	}

	if (history.length > 0) {
		lines.push("  History");
		for (const snapshot of history) {
			lines.push(`  ${formatWidgetRow(snapshot, uiState.updatedAt)}`);
			const summary = summarizeWidgetSnapshot(snapshot);
			if (summary) {
				lines.push(`    ${summary}`);
			}
		}
	}
	return lines;
}

function renderWidget(
	ctx: ExtensionContextLike | undefined,
	uiState: SubagentUiStateSnapshot,
	referenceTime = uiState.updatedAt,
): void {
	if (!ctx?.hasUI || !ctx.ui.setWidget) {
		return;
	}

	ctx.ui.setWidget(UI_WIDGET_KEY, formatWidgetLines({
		...uiState,
		updatedAt: referenceTime,
	}), { placement: "aboveEditor" });
}

function formatElapsedTime(startedAt: string | undefined, endedAt: string | undefined, referenceTime: string): string | undefined {
	if (!startedAt) {
		return undefined;
	}

	const startMs = Date.parse(startedAt);
	const endMs = Date.parse(endedAt ?? referenceTime);
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
		return undefined;
	}

	const elapsedMs = Math.max(0, endMs - startMs);
	const totalSeconds = Math.floor(elapsedMs / 1000);
	const coarseSeconds = totalSeconds < 60 ? Math.floor(totalSeconds / 5) * 5 : totalSeconds;
	if (coarseSeconds < 60) {
		return `${coarseSeconds}s`;
	}

	const totalMinutes = Math.floor(coarseSeconds / 60);
	const seconds = coarseSeconds % 60;
	if (totalMinutes < 60) {
		return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
	}

	const totalHours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`;
}

function summarizeWidgetSnapshot(snapshot: SubagentUiSnapshot): string | undefined {
	if (snapshot.errorMessage) {
		return `error: ${snapshot.errorMessage}`;
	}
	if (snapshot.pendingInputQuestion) {
		return `needs input: ${snapshot.pendingInputQuestion}`;
	}
	if (snapshot.latestSummary) {
		return `latest: ${snapshot.latestSummary}`;
	}
	if (snapshot.finalSummary) {
		return `final: ${snapshot.finalSummary}`;
	}
	return undefined;
}

function formatWidgetRow(snapshot: SubagentUiSnapshot, referenceTime: string): string {
	const badges = [
		snapshot.isStale ? "stale" : undefined,
		snapshot.isDegraded ? "degraded" : undefined,
	].filter((value): value is string => value !== undefined);
	const elapsed = formatElapsedTime(snapshot.startedAt, snapshot.endedAt, referenceTime);
	const segments = [
		snapshot.agentId,
		snapshot.displayName,
		`state=${snapshot.state}`,
		elapsed ? `elapsed=${elapsed}` : undefined,
	];

	return `${segments.filter((value): value is string => value !== undefined).join(" ")}${badges.length > 0 ? ` [${badges.join(", ")}]` : ""}`;
}

function ensureBrowserShortcut(
	ctx: ExtensionContextLike,
	state: ParentSessionState,
	runTmuxCommand: (args: string[]) => ValidationOutcome<string>,
): void {
	if (!ctx.hasUI || !ctx.ui.onTerminalInput || state.terminalInputUnsubscribe) {
		return;
	}

	state.terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
		if (data !== "\u001ba") {
			return undefined;
		}

		const result = openSubagentBrowser(ctx, state, runTmuxCommand);
		if (!result.ok) {
			ctx.ui.notify(result.error, "error");
		}
		return { consume: true, data: "" };
	});
}

function findSnapshot(
	state: ParentSessionState,
	agentId: string,
): SubagentUiSnapshot | undefined {
	return state.uiState.agents.find((snapshot) => snapshot.agentId === agentId);
}

function syncUiState(
	pi: ExtensionApiLike,
	state: ParentSessionState,
	updatedAt: string,
	now: () => string,
): void {
	const currentSnapshots = new Map<string, SubagentUiSnapshot>();
	for (const record of state.manager.listRecords()) {
		const definition = resolveDefinitionForRecord(state, record);
		const snapshotResult = buildSubagentUiSnapshot(record, definition);
		if (snapshotResult.ok) {
			currentSnapshots.set(record.id, snapshotResult.value);
		}
	}

	for (const snapshot of state.uiState.agents) {
		if (!currentSnapshots.has(snapshot.agentId)) {
			currentSnapshots.set(snapshot.agentId, snapshot);
		}
	}

	const nextStateResult = validateSubagentUiStateSnapshot({
		version: 1,
		updatedAt,
		agents: sortUiSnapshots(Array.from(currentSnapshots.values())),
	});
	if (!nextStateResult.ok) {
		return;
	}

	state.uiState = nextStateResult.value;
	pi.appendEntry(UI_STATE_CUSTOM_TYPE, state.uiState);
	renderWidget(state.lastUiContext, state.uiState, now());
	syncWidgetRefresh(state, now);
}

function syncWidgetRefresh(
	state: ParentSessionState,
	now: () => string,
): void {
	const shouldRefresh = state.lastUiContext?.hasUI
		&& state.lastUiContext.ui.setWidget
		&& state.uiState.agents.some((snapshot) => !snapshot.isHistorical && snapshot.startedAt !== undefined);
	if (!shouldRefresh) {
		if (state.widgetRefreshInterval) {
			clearInterval(state.widgetRefreshInterval);
			state.widgetRefreshInterval = undefined;
		}
		return;
	}

	if (state.widgetRefreshInterval) {
		return;
	}

	state.widgetRefreshInterval = setInterval(() => {
		renderWidget(state.lastUiContext, state.uiState, now());
	}, 5_000);
	state.widgetRefreshInterval.unref?.();
}

function fitLine(value: string, width: number): string {
	if (width <= 0) {
		return "";
	}
	if (value.length <= width) {
		return value;
	}
	if (width === 1) {
		return value.slice(0, 1);
	}
	return `${value.slice(0, width - 1)}…`;
}

function captureTmuxViewport(
	runTmuxCommand: (args: string[]) => ValidationOutcome<string>,
	tmuxTarget: string,
	lines: number,
): ValidationOutcome<string[]> {
	const captureResult = runTmuxCommand([
		"capture-pane",
		"-p",
		"-t",
		tmuxTarget,
		"-S",
		`-${Math.max(lines, 1)}`,
	]);
	if (!captureResult.ok) {
		return captureResult;
	}

	return ok(
		captureResult.value
			.split("\n")
			.map((line) => line.replace(/\r/g, ""))
			.filter((line, index, values) => !(index === values.length - 1 && line.length === 0)),
	);
}

function sendTmuxInput(
	runTmuxCommand: (args: string[]) => ValidationOutcome<string>,
	tmuxTarget: string,
	message: string,
): ValidationOutcome<undefined> {
	const literalResult = runTmuxCommand(["send-keys", "-t", tmuxTarget, "-l", message]);
	if (!literalResult.ok) {
		return literalResult as ValidationOutcome<undefined>;
	}
	const enterResult = runTmuxCommand(["send-keys", "-t", tmuxTarget, "Enter"]);
	if (!enterResult.ok) {
		return enterResult as ValidationOutcome<undefined>;
	}
	return ok(undefined);
}

function formatSnapshotBadges(snapshot: SubagentUiSnapshot): string {
	return listSnapshotBadges(snapshot).join(", ") || "none";
}

function listSnapshotBadges(snapshot: SubagentUiSnapshot): string[] {
	return [
		snapshot.isHistorical ? "history" : undefined,
		snapshot.isStale ? "stale" : undefined,
		snapshot.isDegraded ? "degraded" : undefined,
		snapshot.errorMessage ? "error" : undefined,
	].filter((value): value is string => value !== undefined);
}

function padLine(value: string, width: number): string {
	const clipped = fitLine(value, width);
	return clipped + " ".repeat(Math.max(0, width - clipped.length));
}

function composeColumns(leftLines: string[], rightLines: string[], width: number, rightWidth = 30, gap = 3): string[] {
	if (width < rightWidth + gap + 40) {
		return [...leftLines, "", ...rightLines];
	}

	const resolvedRightWidth = Math.min(rightWidth, Math.max(20, width - 45));
	const resolvedLeftWidth = Math.max(20, width - resolvedRightWidth - gap);
	const rowCount = Math.max(leftLines.length, rightLines.length);
	const lines: string[] = [];

	for (let index = 0; index < rowCount; index += 1) {
		lines.push(
			`${padLine(leftLines[index] ?? "", resolvedLeftWidth)}${" ".repeat(gap)}${padLine(rightLines[index] ?? "", resolvedRightWidth)}`,
		);
	}

	return lines;
}

function buildSnapshotSummaryLines(snapshot: SubagentUiSnapshot, width: number): string[] {
	const lines = [
		fitLine(`${snapshot.displayName} · ${snapshot.agentId}`, width),
		fitLine(`state=${snapshot.state} · availability=${snapshot.availability} · badges=${formatSnapshotBadges(snapshot)}`, width),
	];

	if (snapshot.description) {
		lines.push(fitLine(`Description: ${snapshot.description}`, width));
	}
	const elapsed = formatElapsedTime(snapshot.startedAt, snapshot.endedAt, new Date().toISOString());
	if (elapsed) {
		lines.push(fitLine(`Elapsed: ${elapsed}`, width));
	}

	if (snapshot.errorMessage) {
		lines.push("");
		lines.push("Error");
		lines.push(fitLine(snapshot.errorMessage, width));
	}
	if (snapshot.pendingInputQuestion) {
		lines.push("");
		lines.push("Needs input");
		lines.push(fitLine(snapshot.pendingInputQuestion, width));
	}
	if (snapshot.latestSummary) {
		lines.push("");
		lines.push("Latest");
		lines.push(fitLine(snapshot.latestSummary, width));
	}
	if (snapshot.finalSummary) {
		lines.push("");
		lines.push("Final");
		lines.push(fitLine(snapshot.finalSummary, width));
	}
	if (snapshot.note) {
		lines.push("");
		lines.push("Note");
		lines.push(fitLine(snapshot.note, width));
	}

	return lines;
}

function renderWorkspaceLines(
	snapshot: SubagentUiSnapshot,
	mode: "peek" | "follow",
	paneLines: ReadonlyArray<string>,
	scrollOffset: number,
	statusMessage: string | undefined,
	width: number,
	referenceTime: string,
): string[] {
	const contentWidth = Math.max(40, width);
	const elapsed = formatElapsedTime(snapshot.startedAt, snapshot.endedAt, referenceTime);
	const header = [
		fitLine(`Subagent ${snapshot.agentId} · ${snapshot.displayName}`, contentWidth),
		fitLine(`Workspace · ${snapshot.isHistorical ? "history" : mode}`, contentWidth),
		fitLine(`Mode: ${snapshot.isHistorical ? "history" : mode} · state=${snapshot.state} · availability=${snapshot.availability}`, contentWidth),
		fitLine(`Badges: ${formatSnapshotBadges(snapshot)}${elapsed ? ` · elapsed=${elapsed}` : ""}`, contentWidth),
		"",
	];

	if (snapshot.isHistorical || mode === "peek") {
		return [
			...header,
			fitLine(snapshot.isHistorical ? "Historical detail" : "Peek is summary-first and read-only.", contentWidth),
			"",
			...buildSnapshotSummaryLines(snapshot, contentWidth),
			"",
			fitLine(snapshot.isHistorical ? "Esc closes." : "F Follow · T Take Over · Esc back", contentWidth),
		];
	}

	const viewportWindow = 28;
	const maxStart = Math.max(0, paneLines.length - viewportWindow);
	const start = Math.max(0, maxStart - scrollOffset);
	const visiblePaneLines = paneLines.slice(start, start + viewportWindow);
	const leftLines = [
		"Live child terminal",
		`Showing ${start + 1}-${Math.min(paneLines.length, start + viewportWindow)} of ${paneLines.length}`,
		"",
		...(visiblePaneLines.length > 0 ? visiblePaneLines : ["(no child terminal output yet)"]),
		"",
		statusMessage ?? "Follow is read-only in phase 1.",
	].map((line) => fitLine(line, Math.max(20, contentWidth - 33)));

	const rightLines = [
		...buildSnapshotSummaryLines(snapshot, 30),
		"",
		"Keys",
		"Up/Down scroll",
		"PgUp/PgDn jump",
		"T Take Over",
		"Esc back",
	];

	return [...header, ...composeColumns(leftLines, rightLines, contentWidth, 30, 3)];
}

function extractTmuxSessionName(tmuxTarget: string): string {
	const separatorIndex = tmuxTarget.indexOf(":");
	return separatorIndex === -1 ? tmuxTarget : tmuxTarget.slice(0, separatorIndex);
}

interface WorkspaceActions {
	open(agentId: string, mode: SubagentOpenMode): void;
}

class SubagentWorkspaceComponent {
	public focused = true;
	private paneLines: string[] = [];
	private statusMessage: string | undefined;
	private scrollOffset = 0;
	private readonly refreshInterval: ReturnType<typeof setInterval> | undefined;

	public constructor(
		private readonly loadSnapshot: () => SubagentUiSnapshot | undefined,
		private readonly initialSnapshot: SubagentUiSnapshot,
		private readonly mode: Exclude<SubagentOpenMode, "take_over">,
		private readonly runTmuxCommand: (args: string[]) => ValidationOutcome<string>,
		private readonly requestRender: () => void,
		private readonly close: () => void,
		private readonly actions: WorkspaceActions,
	) {
		this.refreshViewport();
		if (!initialSnapshot.isHistorical && mode === "follow") {
			this.refreshInterval = setInterval(() => {
				this.refreshViewport();
				this.requestRender();
			}, 500);
			this.refreshInterval.unref?.();
		}
	}

	public invalidate(): void {}

	public dispose(): void {
		if (this.refreshInterval) {
			clearInterval(this.refreshInterval);
		}
	}

	public handleInput(data: string): void {
		const snapshot = this.loadSnapshot() ?? this.initialSnapshot;
		if (data === "\u001b") {
			this.close();
			return;
		}

		if (!snapshot.isHistorical && data.toLowerCase() === "t") {
			this.close();
			queueMicrotask(() => this.actions.open(snapshot.agentId, "take_over"));
			return;
		}

		if (!snapshot.isHistorical && this.mode !== "follow" && data.toLowerCase() === "f") {
			this.close();
			queueMicrotask(() => this.actions.open(snapshot.agentId, "follow"));
			return;
		}

		if (this.mode !== "follow") {
			return;
		}

		if (data === "\u001b[A") {
			this.scrollOffset = Math.min(this.scrollOffset + 1, Math.max(0, this.paneLines.length - 1));
			this.requestRender();
			return;
		}
		if (data === "\u001b[B") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.requestRender();
			return;
		}
		if (data === "\u001b[5~") {
			this.scrollOffset = Math.min(this.scrollOffset + 8, Math.max(0, this.paneLines.length - 1));
			this.requestRender();
			return;
		}
		if (data === "\u001b[6~") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 8);
			this.requestRender();
		}
	}

	public render(width: number): string[] {
		const snapshot = this.loadSnapshot() ?? this.initialSnapshot;
		return renderWorkspaceLines(
			snapshot,
			this.mode,
			this.paneLines,
			this.scrollOffset,
			this.statusMessage,
			width,
			new Date().toISOString(),
		);
	}

	private refreshViewport(): void {
		const snapshot = this.loadSnapshot() ?? this.initialSnapshot;
		if (snapshot.isHistorical || this.mode !== "follow") {
			this.paneLines = [];
			return;
		}

		const captureResult = captureTmuxViewport(this.runTmuxCommand, snapshot.tmuxTarget, 160);
		if (!captureResult.ok) {
			this.statusMessage = `Child terminal unavailable: ${captureResult.error}`;
			this.paneLines = [];
			return;
		}

		this.paneLines = captureResult.value;
		if (this.statusMessage?.startsWith("Child terminal unavailable:")) {
			this.statusMessage = undefined;
		}
	}
}

class SubagentBrowserComponent {
	public focused = true;
	private selectedIndex = 0;

	public constructor(
		private readonly snapshots: ReadonlyArray<SubagentUiSnapshot>,
		private readonly actions: WorkspaceActions,
		private readonly requestRender: () => void,
		private readonly close: () => void,
	) {}

	public invalidate(): void {}
	public dispose(): void {}

	public handleInput(data: string): void {
		if (data === "\u001b") {
			this.close();
			return;
		}
		if (data === "\u001b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (data === "\u001b[B") {
			this.selectedIndex = Math.min(this.snapshots.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}

		const selected = this.snapshots[this.selectedIndex];
		if (!selected) {
			return;
		}

		if (data === "\r" || data === "\n") {
			this.close();
			queueMicrotask(() => this.actions.open(selected.agentId, "peek"));
			return;
		}
		if (!selected.isHistorical && data.toLowerCase() === "f") {
			this.close();
			queueMicrotask(() => this.actions.open(selected.agentId, "follow"));
			return;
		}
		if (!selected.isHistorical && data.toLowerCase() === "t") {
			this.close();
			queueMicrotask(() => this.actions.open(selected.agentId, "take_over"));
		}
	}

	public render(width: number): string[] {
		return renderBrowserLines(this.snapshots, this.selectedIndex, width, new Date().toISOString());
	}
}

function renderBrowserLines(
	snapshots: ReadonlyArray<SubagentUiSnapshot>,
	selectedIndex: number,
	width: number,
	referenceTime: string,
): string[] {
	const lines = [
		fitLine("Subagent Browser", width),
		fitLine("Enter Peek · F Follow · T Take Over · Esc close", width),
		"",
	];

	if (snapshots.length === 0) {
		lines.push("No subagents in this session.");
		return lines;
	}

	const live = snapshots.filter((snapshot) => !snapshot.isHistorical);
	const history = snapshots.filter((snapshot) => snapshot.isHistorical);
	let rowIndex = 0;

	if (live.length > 0) {
		lines.push(`Live (${live.length})`);
		for (const snapshot of live) {
			const prefix = rowIndex === selectedIndex ? ">" : " ";
			const elapsed = formatElapsedTime(snapshot.startedAt, snapshot.endedAt, referenceTime);
			const badges = listSnapshotBadges(snapshot).join(", ") || "live";
			lines.push(fitLine(`${prefix} ${snapshot.displayName} · ${snapshot.agentId}`, width));
			lines.push(fitLine(`  state=${snapshot.state} · ${badges}${elapsed ? ` · ${elapsed}` : ""}`, width));
			const summary = summarizeWidgetSnapshot(snapshot) ?? snapshot.note;
			if (summary) {
				lines.push(fitLine(`  ${summary}`, width));
			}
			rowIndex += 1;
		}
		lines.push("");
	}

	if (history.length > 0) {
		lines.push(`History (${history.length})`);
		for (const snapshot of history) {
			const prefix = rowIndex === selectedIndex ? ">" : " ";
			const elapsed = formatElapsedTime(snapshot.startedAt, snapshot.endedAt, referenceTime);
			const badges = listSnapshotBadges(snapshot).join(", ") || "history";
			lines.push(fitLine(`${prefix} ${snapshot.displayName} · ${snapshot.agentId}`, width));
			lines.push(fitLine(`  state=${snapshot.state} · ${badges}${elapsed ? ` · ${elapsed}` : ""}`, width));
			const summary = summarizeWidgetSnapshot(snapshot) ?? snapshot.note;
			if (summary) {
				lines.push(fitLine(`  ${summary}`, width));
			}
			rowIndex += 1;
		}
	}

	return lines;
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

function wrapText(value: string, width: number): string[] {
	if (width <= 0) {
		return [value];
	}

	const normalized = value.replace(/\r/g, "");
	const wrapped: string[] = [];
	for (const rawLine of normalized.split("\n")) {
		if (rawLine.length === 0) {
			wrapped.push("");
			continue;
		}

		let remaining = rawLine;
		while (remaining.length > width) {
			const slice = remaining.slice(0, width + 1);
			const breakIndex = slice.lastIndexOf(" ");
			const cut = breakIndex > Math.floor(width / 2) ? breakIndex : width;
			wrapped.push(remaining.slice(0, cut).trimEnd());
			remaining = remaining.slice(cut).trimStart();
		}
		wrapped.push(remaining);
	}

	return wrapped;
}

function renderMessageBlock(title: string, bodyLines: ReadonlyArray<string>, width: number): string[] {
	const contentWidth = Math.max(24, width);
	const lines = [fitLine(title, contentWidth)];
	for (const line of bodyLines) {
		lines.push(...wrapText(line, contentWidth));
	}
	return lines;
}

function renderCustomMessage(title: string, bodyLines: ReadonlyArray<string>): MessageRendererLike {
	return {
		render(width: number): string[] {
			return renderMessageBlock(title, bodyLines, width);
		},
	};
}

function trimRedundantRendererHeading(content: string, predicate: (line: string) => boolean): string[] {
	const lines = content.split("\n");
	if (lines.length > 0 && predicate(lines[0])) {
		return lines.slice(1);
	}
	return lines;
}

function registerMessageRenderers(pi: ExtensionApiLike): void {
	pi.registerMessageRenderer("pi-nexus-subagent-progress", (message) => {
		const details = message.details as { agentId?: string; state?: string } | undefined;
		const title = details?.agentId
			? `Subagent progress · ${details.agentId}${details.state ? ` · ${details.state}` : ""}`
			: "Subagent progress";
		return renderCustomMessage(title, typeof message.content === "string" ? message.content.split("\n") : []);
	});

	pi.registerMessageRenderer("pi-nexus-subagent-status", (message) => {
		const details = message.details as { agentId?: string } | undefined;
		const title = details?.agentId ? `Subagent status · ${details.agentId}` : "Subagent status";
		return renderCustomMessage(title, typeof message.content === "string" ? message.content.split("\n") : []);
	});

	pi.registerMessageRenderer("pi-nexus-subagent-open", (message) => {
		const details = message.details as { agentId?: string; mode?: string } | undefined;
		const title = details?.agentId
			? `Subagent open · ${details.agentId}${details.mode ? ` · ${details.mode}` : ""}`
			: "Subagent open";
		const bodyLines = typeof message.content === "string"
			? trimRedundantRendererHeading(message.content, (line) => line.startsWith("Opened "))
			: [];
		return renderCustomMessage(title, bodyLines);
	});

	pi.registerMessageRenderer("pi-nexus-subagents-output", (message) => {
		const details = message.details as { command?: string } | undefined;
		const title = details?.command ? `Subagents · ${details.command}` : "Subagents";
		return renderCustomMessage(title, typeof message.content === "string" ? message.content.split("\n") : []);
	});
}

function formatSnapshotStatusLine(snapshot: SubagentUiSnapshot, referenceTime: string): string {
	const badges = formatSnapshotBadges(snapshot);
	const elapsed = formatElapsedTime(snapshot.startedAt, snapshot.endedAt, referenceTime);
	return [
		`state=${snapshot.state}`,
		`availability=${snapshot.availability}`,
		badges !== "none" ? `badges=${badges}` : undefined,
		elapsed ? `elapsed=${elapsed}` : undefined,
	].filter((value): value is string => value !== undefined).join(" · ");
}

function formatSnapshotSummaryPreview(snapshot: SubagentUiSnapshot): string | undefined {
	if (snapshot.errorMessage) {
		return `Error: ${snapshot.errorMessage}`;
	}
	if (snapshot.pendingInputQuestion) {
		return `Needs input: ${snapshot.pendingInputQuestion}`;
	}
	if (snapshot.finalSummary) {
		return `Final: ${snapshot.finalSummary}`;
	}
	if (snapshot.latestSummary) {
		return `Latest: ${snapshot.latestSummary}`;
	}
	if (snapshot.note) {
		return `Note: ${snapshot.note}`;
	}
	return undefined;
}

function formatListText(state: ParentSessionState, referenceTime: string): string {
	if (state.uiState.agents.length === 0) {
		return "Subagents · live=0 · history=0\n\nNo subagents are currently managed in this Pi session.";
	}

	const live = state.uiState.agents.filter((snapshot) => !snapshot.isHistorical);
	const history = state.uiState.agents.filter((snapshot) => snapshot.isHistorical);
	const lines = [`Subagents · live=${live.length} · history=${history.length}`, ""];

	const appendGroup = (title: string, snapshots: ReadonlyArray<SubagentUiSnapshot>) => {
		if (snapshots.length === 0) {
			return;
		}
		lines.push(title);
		for (const snapshot of snapshots) {
			lines.push(`- ${snapshot.displayName} · ${snapshot.agentId}`);
			lines.push(`  ${formatSnapshotStatusLine(snapshot, referenceTime)}`);
			const preview = formatSnapshotSummaryPreview(snapshot);
			if (preview) {
				lines.push(`  ${preview}`);
			}
		}
		lines.push("");
	};

	appendGroup("Live", live);
	appendGroup("History", history);
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines.join("\n");
}

function buildAgentActionText(
	heading: string,
	snapshot: SubagentUiSnapshot,
	referenceTime: string,
	extraLines: ReadonlyArray<string> = [],
): string {
	const lines = [
		heading,
		`${snapshot.displayName} · ${snapshot.agentId}`,
		formatSnapshotStatusLine(snapshot, referenceTime),
	];
	const preview = formatSnapshotSummaryPreview(snapshot);
	if (preview) {
		lines.push(preview);
	}
	if (extraLines.length > 0) {
		lines.push("", ...extraLines);
	}
	return lines.join("\n");
}

function buildOpenPresentationText(
	snapshot: SubagentUiSnapshot,
	openMessage: string,
	mode: string,
	referenceTime: string,
): string {
	return buildAgentActionText(openMessage, snapshot, referenceTime, [`Mode: ${mode}`]);
}

function formatChildEventText(
	kind: "final_result" | "needs_input" | "error",
	label: string,
	primaryLine: string,
	dataLine?: string,
): string {
	const heading = kind === "final_result"
		? `Subagent final_result from ${label}.`
		: kind === "needs_input"
			? `Subagent needs_input from ${label}.`
			: `Subagent error from ${label}.`;
	return [heading, primaryLine, dataLine]
		.filter((line): line is string => typeof line === "string" && line.length > 0)
		.join("\n");
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
			break;
		case "final_result":
			deliverChildFollowUp(
				pi,
				state,
				formatChildEventText(
					"final_result",
					label,
					`Summary: ${event.payload.summary}`,
					renderDataBlock(event.payload.data),
				),
			);
			break;
		case "needs_input":
			deliverChildFollowUp(
				pi,
				state,
				formatChildEventText(
					"needs_input",
					label,
					`Question: ${event.payload.question}`,
				),
			);
			break;
		case "error":
			deliverChildFollowUp(
				pi,
				state,
				formatChildEventText(
					"error",
					label,
					`Message: ${event.payload.message}`,
					`Fatal: ${event.payload.fatal ? "yes" : "no"}`,
				),
			);
			break;
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
			break;
		case "ready":
		case "state":
		case "pong":
			break;
	}

	syncUiState(pi, state, event.time, state.now);
}

function createParentSessionState(
	pi: ExtensionApiLike,
	sessionFile: string,
	cwd: string,
	sessionEntries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
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
		now: options.now,
		manager: undefined as unknown as SubagentManager,
		busy: false,
		nextAgentOrdinal: 0,
		ownedTmuxRuntimes: new Map<string, OwnedTmuxRuntime>(),
		uiState: restoreUiStateFromEntries(sessionEntries, options.now),
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
		currentState.lastUiContext = ctx;
		ensureBrowserShortcut(ctx, currentState, options.runTmuxCommand);
		renderWidget(currentState.lastUiContext, currentState.uiState, options.now());
		syncWidgetRefresh(currentState, options.now);
		return ok(currentState);
	}

	return createParentSessionState(pi, sessionFile, ctx.cwd, ctx.sessionManager.getEntries(), options);
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
		`Open availability: ${focusTarget?.availability === "stopped" ? "history" : focusTarget?.availability ?? "unknown"}`,
		"Use the Subagent tool with action=open, send, or interrupt to keep interacting from the parent session.",
		"Use /subagents or Alt+A to open the subagent browser in the TUI.",
	].join("\n");
}

function spawnNamedSubagent(
	pi: ExtensionApiLike,
	state: ParentSessionState,
	params: Static<typeof AGENT_TOOL_PARAMETERS>,
	effectiveOptions: EffectiveParentExtensionOptions,
): ToolResultLike<SubagentToolDetails> {
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
	syncUiState(pi, state, effectiveOptions.now(), effectiveOptions.now);
	return textResult(
		buildSpawnText(
			spawnResult.value,
			preparedResult.value.definition,
			focusResult.ok ? focusResult.value : undefined,
		),
		{
			action: "spawn",
			agentId,
			state: spawnResult.value.state,
			subagentType: preparedResult.value.definition.name,
			displayName: formatDisplayName(preparedResult.value.definition, spawnResult.value),
			openAvailability: focusResult.ok ? focusResult.value.availability : "unknown",
		},
	);
}

function requireAgentId(agentId: string | undefined, action: "send" | "interrupt" | "open" | "focus"): ValidationOutcome<string> {
	if (!agentId || agentId.trim().length === 0) {
		return fail(`action=${action} requires agent_id`);
	}
	return ok(agentId.trim());
}

function buildListToolResult(state: ParentSessionState): ToolResultLike<SubagentToolDetails> {
	return textResult(formatListText(state, state.now()), { action: "list" });
}

function buildSendToolResult(
	state: ParentSessionState,
	agentId: string,
	message: string | undefined,
): ToolResultLike<SubagentToolDetails> {
	if (!message || message.trim().length === 0) {
		return textResult("action=send requires message");
	}

	const sendResult = state.manager.sendFollowUp(agentId, message.trim());
	if (!sendResult.ok) {
		return textResult(`Failed to send follow-up to ${agentId}: ${sendResult.error}`);
	}

	const snapshot = findSnapshot(state, agentId);
	if (!snapshot) {
		return textResult(`Queued follow-up for ${agentId}.\nMessage: ${message.trim()}`, {
			action: "send",
			agentId,
		});
	}

	return textResult(buildAgentActionText(
		`Queued follow-up for ${agentId}.`,
		snapshot,
		state.now(),
		["Message", message.trim()],
	), {
		action: "send",
		agentId,
		state: snapshot.state,
		displayName: snapshot.displayName,
		openAvailability: snapshot.availability,
	});
}

function buildInterruptToolResult(
	state: ParentSessionState,
	agentId: string,
): ToolResultLike<SubagentToolDetails> {
	const interruptResult = state.manager.sendInterrupt(agentId);
	if (!interruptResult.ok) {
		return textResult(`Failed to interrupt ${agentId}: ${interruptResult.error}`);
	}

	const snapshot = findSnapshot(state, agentId);
	if (!snapshot) {
		return textResult(`Sent interrupt to ${agentId}.`, {
			action: "interrupt",
			agentId,
		});
	}

	return textResult(buildAgentActionText(
		`Sent interrupt to ${agentId}.`,
		snapshot,
		state.now(),
		["The parent requested the child to stop current work."],
	), {
		action: "interrupt",
		agentId,
		state: snapshot.state,
		displayName: snapshot.displayName,
		openAvailability: snapshot.availability,
	});
}

function normalizeSubagentsCommandArgs(args: string): string {
	const trimmed = args.trim();
	if (!trimmed.startsWith("subagents")) {
		return trimmed;
	}

	const remainder = trimmed.slice("subagents".length);
	if (remainder.length === 0) {
		return "";
	}

	return remainder.startsWith(" ") ? remainder.trimStart() : trimmed;
}

function openSubagentTakeOver(
	ctx: ExtensionContextLike,
	snapshot: SubagentUiSnapshot,
): ValidationOutcome<string> {
	if (!ctx.hasUI || !ctx.ui.custom) {
		return fail("Native subagent open requires the interactive TUI.");
	}
	if (snapshot.isHistorical) {
		return fail("Take Over is only available for live children.");
	}

	void ctx.ui.custom<void>(
		(tui, _theme, _keybindings, done) => {
			const sessionName = extractTmuxSessionName(snapshot.tmuxTarget);
			const configPath = path.join(os.tmpdir(), `pi-nexus-takeover-${process.pid}-${Date.now()}.tmux.conf`);
			fs.writeFileSync(
				configPath,
				[
					"set-option -g status off",
					"set-option -g prefix None",
					"unbind-key C-b",
					"bind-key -n C-] detach-client",
				].join("\n"),
				"utf8",
			);

			tui.stop?.();
			process.stdout.write("\x1b[2J\x1b[H");
			try {
				childProcess.spawnSync("tmux", ["-f", configPath, "attach-session", "-t", sessionName], {
					stdio: "inherit",
					env: process.env,
				});
			} finally {
				fs.rmSync(configPath, { force: true });
				tui.start?.();
				tui.requestRender(true);
				done(undefined);
			}

			return {
				render: () => [],
				invalidate() {},
			};
		},
		{
			screen: true,
		},
	).catch((error) => {
		ctx.ui.notify(`Failed to start Take Over: ${normalizeError(error).message}`, "error");
	});

	return ok(`Entered Take Over for ${snapshot.agentId}. Press Ctrl+] to return to pi.`);
}

function openSubagentView(
	ctx: ExtensionContextLike,
	state: ParentSessionState,
	agentId: string,
	mode: SubagentOpenMode,
	runTmuxCommand: (args: string[]) => ValidationOutcome<string>,
): ValidationOutcome<string> {
	if (!ctx.hasUI || !ctx.ui.custom) {
		return fail("Native subagent open requires the interactive TUI.");
	}

	const loadSnapshot = () => findSnapshot(state, agentId);
	const snapshot = loadSnapshot();
	if (!snapshot) {
		return fail(`Unknown subagent: ${agentId}`);
	}
	if (mode === "take_over") {
		return openSubagentTakeOver(ctx, snapshot);
	}

	const effectiveMode = snapshot.isHistorical ? "peek" : mode;
	void ctx.ui.custom<void>(
		(tui, _theme, _keybindings, done) =>
			new SubagentWorkspaceComponent(
				loadSnapshot,
				snapshot,
				effectiveMode,
				runTmuxCommand,
				() => tui.requestRender(),
				() => done(undefined),
				{
					open: (nextAgentId, nextMode) => {
						const nextSnapshot = findSnapshot(state, nextAgentId);
						if (!nextSnapshot) {
							ctx.ui.notify(`Unknown subagent: ${nextAgentId}`, "error");
							return;
						}
						const result = openSubagentView(ctx, state, nextAgentId, nextMode, runTmuxCommand);
						if (!result.ok) {
							ctx.ui.notify(result.error, "error");
						}
					},
				},
			),
		{
			screen: true,
		},
	).catch((error) => {
		ctx.ui.notify(`Failed to open subagent view: ${normalizeError(error).message}`, "error");
	});

	return ok(
		snapshot.isHistorical
			? `Opened ${snapshot.agentId} history detail.`
			: mode === "follow"
				? `Opened ${snapshot.agentId} in Follow.`
				: `Opened ${snapshot.agentId} in Peek.`,
	);
}

function openSubagentBrowser(
	ctx: ExtensionContextLike,
	state: ParentSessionState,
	runTmuxCommand: (args: string[]) => ValidationOutcome<string>,
): ValidationOutcome<string> {
	if (!ctx.hasUI || !ctx.ui.custom) {
		return fail("Subagent browser requires the interactive TUI.");
	}

	void ctx.ui.custom<void>(
		(tui, _theme, _keybindings, done) =>
			new SubagentBrowserComponent(state.uiState.agents, {
				open: (agentId, mode) => {
					const result = openSubagentView(ctx, state, agentId, mode, runTmuxCommand);
					if (!result.ok) {
						ctx.ui.notify(result.error, "error");
					}
				},
			}, () => tui.requestRender(), () => done(undefined)),
		{
			screen: true,
		},
	).catch((error) => {
		ctx.ui.notify(`Failed to open subagent browser: ${normalizeError(error).message}`, "error");
	});

	return ok("Opened subagent browser.");
}

function buildOpenToolResult(
	pi: ExtensionApiLike,
	state: ParentSessionState,
	agentId: string,
	mode: SubagentOpenMode,
	ctx: ExtensionContextLike,
	effectiveOptions: EffectiveParentExtensionOptions,
): ToolResultLike<SubagentToolDetails> {
	const snapshot = findSnapshot(state, agentId);
	if (!snapshot) {
		return textResult(`Unknown subagent: ${agentId}`);
	}

	const openResult = openSubagentView(ctx, state, agentId, mode, effectiveOptions.runTmuxCommand);
	if (!openResult.ok) {
		return textResult(openResult.error, {
			action: "open",
			agentId,
			mode,
			state: snapshot.state,
			displayName: snapshot.displayName,
			openAvailability: snapshot.availability,
		});
	}

	ctx.ui.notify(openResult.value, "info");
	const effectiveMode = snapshot.isHistorical ? "history" : mode;
	const openText = buildOpenPresentationText(snapshot, openResult.value, effectiveMode, effectiveOptions.now());
	sendSessionMessage(
		pi,
		"pi-nexus-subagent-open",
		openText,
		{
			agentId,
			mode: effectiveMode,
			state: snapshot.state,
			availability: snapshot.availability,
		},
	);
	return textResult(openText, {
		action: "open",
		agentId,
		mode,
		state: snapshot.state,
		displayName: snapshot.displayName,
		openAvailability: snapshot.availability,
	});
}

function shutdownParentSession(
	pi: ExtensionApiLike,
	state: ParentSessionState | undefined,
	now: () => string,
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
	state.terminalInputUnsubscribe?.();
	state.terminalInputUnsubscribe = undefined;
	if (state.widgetRefreshInterval) {
		clearInterval(state.widgetRefreshInterval);
		state.widgetRefreshInterval = undefined;
	}
	syncUiState(pi, state, now(), now);
}

function notifyRuntimePreparationFailure(ctx: ExtensionContextLike, error: string): void {
	ctx.ui.notify(`pi-nexus parent session setup failed: ${error}`, "error");
}

export function installParentExtension(
	pi: ExtensionApiLike,
	options: ParentExtensionOptions = {},
): void {
	registerMessageRenderers(pi);

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
			shutdownParentSession(pi, activeState, effectiveOptions.now, effectiveOptions.runTmuxCommand);
		}
		const stateResult = ensureCurrentState(pi, activeState, ctx, effectiveOptions);
		if (!stateResult.ok) {
			activeState = undefined;
			notifyRuntimePreparationFailure(ctx, stateResult.error);
			return;
		}
		activeState = stateResult.value;
		activeState.lastUiContext = ctx;
		ensureBrowserShortcut(ctx, activeState, effectiveOptions.runTmuxCommand);
		renderWidget(ctx, activeState.uiState, effectiveOptions.now());
		syncWidgetRefresh(activeState, effectiveOptions.now);
	});

	pi.on("agent_start", async (_event, ctx) => {
		const stateResult = ensureCurrentState(pi, activeState, ctx, effectiveOptions);
		if (!stateResult.ok) {
			activeState = undefined;
			notifyRuntimePreparationFailure(ctx, stateResult.error);
			return;
		}
		activeState = stateResult.value;
		activeState.lastUiContext = ctx;
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
		activeState.lastUiContext = ctx;
		activeState.busy = false;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const shuttingDownSessionFile = ctx.sessionManager.getSessionFile();
		if (!activeState || activeState.sessionFile !== shuttingDownSessionFile) {
			return;
		}

		shutdownParentSession(pi, activeState, effectiveOptions.now, effectiveOptions.runTmuxCommand);
		activeState = undefined;
	});

	pi.registerTool<typeof SUBAGENT_TOOL_PARAMETERS, SubagentToolDetails>({
		name: "Subagent",
		label: "Subagent",
		description: "Manage pi-nexus subagents: spawn, list, open native views, send follow-ups, or interrupt.",
		promptSnippet: "Manage live pi-nexus subagents with structured actions.",
		promptGuidelines: [
			"Use action=spawn to start a named subagent.",
			"Use action=open to inspect or take over a child from the native TUI with mode=peek, follow, or take_over.",
			"Use action=send to continue a running child after a progress or final_result callback.",
			"Use action=interrupt to stop current child work without using tmux.",
			"Use action=list to inspect current managed and historical children.",
		],
		parameters: SUBAGENT_TOOL_PARAMETERS,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const stateResult = ensureCurrentState(pi, activeState, ctx, effectiveOptions);
			if (!stateResult.ok) {
				activeState = undefined;
				return textResult(`Failed to prepare parent session runtime: ${stateResult.error}`);
			}
			activeState = stateResult.value;
			const state = activeState;

			switch (params.action) {
				case "spawn":
					if (!params.prompt || !params.description || !params.subagent_type) {
						return textResult("action=spawn requires prompt, description, and subagent_type");
					}
					return spawnNamedSubagent(pi, state, {
						prompt: params.prompt,
						description: params.description,
						subagent_type: params.subagent_type,
						tmux_mode: params.tmux_mode,
					}, effectiveOptions);
				case "list":
					return buildListToolResult(state);
				case "open": {
					const agentIdResult = requireAgentId(params.agent_id, "open");
					if (!agentIdResult.ok) {
						return textResult(agentIdResult.error);
					}
					const modeResult = validateSubagentOpenMode(params.mode ?? "peek");
					if (!modeResult.ok) {
						return textResult(modeResult.error);
					}
					return buildOpenToolResult(pi, state, agentIdResult.value, modeResult.value, ctx, effectiveOptions);
				}
				case "focus": {
					return textResult(LEGACY_FOCUS_MESSAGE, {
						action: "focus",
					});
				}
				case "send": {
					const agentIdResult = requireAgentId(params.agent_id, "send");
					if (!agentIdResult.ok) {
						return textResult(agentIdResult.error);
					}
					return buildSendToolResult(state, agentIdResult.value, params.message);
				}
				case "interrupt": {
					const agentIdResult = requireAgentId(params.agent_id, "interrupt");
					if (!agentIdResult.ok) {
						return textResult(agentIdResult.error);
					}
					return buildInterruptToolResult(state, agentIdResult.value);
				}
			}
		},
	});

	pi.registerCommand("subagents", {
		description: "Open the subagent browser, inspect child views, or send follow-ups.",
		getArgumentCompletions: (argumentPrefix) => {
			const trimmed = argumentPrefix.trimStart();
			if (trimmed.length === 0) {
				return [
					{ value: "list", label: "list" },
					{ value: "open ", label: "open <agentId> [mode]" },
					{ value: "send ", label: "send <agentId> <message>" },
				];
			}

			if (trimmed.startsWith("open ")) {
				const openPrefix = trimmed.slice("open ".length);
				if (!openPrefix.includes(" ")) {
					const items = activeState?.uiState.agents ?? [];
					return items
						.filter((record) => record.agentId.startsWith(openPrefix))
						.map((record) => ({
							value: `open ${record.agentId} `,
							label: record.agentId,
						}));
				}
				const [agentId, modePrefix] = openPrefix.split(/\s+/, 2);
				if (agentId) {
					return ["peek", "follow", "take_over"]
						.filter((mode) => mode.startsWith(modePrefix ?? ""))
						.map((mode) => ({
							value: `open ${agentId} ${mode}`,
							label: mode,
						}));
				}
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

			if (trimmed.startsWith("send ")) {
				const sendPrefix = trimmed.slice("send ".length);
				if (!sendPrefix.includes(" ")) {
					const items = activeState?.manager.listRecords() ?? [];
					return items
						.filter((record) => record.id.startsWith(sendPrefix))
						.map((record) => ({
							value: `send ${record.id} `,
							label: record.id,
						}));
				}
			}

			const commands = ["list", "open", "send", "focus"];
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
			const trimmed = normalizeSubagentsCommandArgs(args);
			const [command, ...rest] = trimmed.split(/\s+/).filter((entry) => entry.length > 0);

			if (!command) {
				const browserResult = openSubagentBrowser(ctx, state, effectiveOptions.runTmuxCommand);
				if (!browserResult.ok) {
					sendSessionMessage(pi, "pi-nexus-subagents-output", browserResult.error, {
						command: "browse",
					});
				}
				return;
			}

			if (command === "list") {
				sendSessionMessage(pi, "pi-nexus-subagents-output", formatListText(state, effectiveOptions.now()), {
					command: "list",
				});
				return;
			}

			if (command === "open") {
				const agentId = rest.shift()?.trim() ?? "";
				const modeResult = validateSubagentOpenMode(rest.shift() ?? "peek");
				if (!agentId) {
					sendSessionMessage(pi, "pi-nexus-subagents-output", "Usage: /subagents open <agentId> [peek|follow|take_over]", {
						command: "open",
					});
					return;
				}
				if (!modeResult.ok) {
					sendSessionMessage(
						pi,
						"pi-nexus-subagents-output",
						modeResult.error,
						{ command: "open", agentId },
					);
					return;
				}

				const snapshot = findSnapshot(state, agentId);
				if (!snapshot) {
					sendSessionMessage(
						pi,
						"pi-nexus-subagents-output",
						`Unknown subagent: ${agentId}`,
						{ command: "open", agentId },
					);
					return;
				}

				const openResult = openSubagentView(ctx, state, agentId, modeResult.value, effectiveOptions.runTmuxCommand);
				if (!openResult.ok) {
					sendSessionMessage(pi, "pi-nexus-subagents-output", openResult.error, {
						command: "open",
						agentId,
					});
					return;
				}

				ctx.ui.notify(openResult.value, "info");
				sendSessionMessage(
					pi,
					"pi-nexus-subagent-open",
					buildOpenPresentationText(
						snapshot,
						openResult.value,
						snapshot.isHistorical ? "history" : modeResult.value,
						effectiveOptions.now(),
					),
					{
						agentId,
						mode: snapshot.isHistorical ? "history" : modeResult.value,
						state: snapshot.state,
						availability: snapshot.availability,
					},
				);
				return;
			}

			if (command === "focus") {
				sendSessionMessage(pi, "pi-nexus-subagents-output", LEGACY_FOCUS_MESSAGE, { command: "focus" });
				return;
			}

			if (command === "send") {
				const agentId = rest.shift()?.trim() ?? "";
				const message = rest.join(" ").trim();
				if (!agentId || !message) {
					sendSessionMessage(
						pi,
						"pi-nexus-subagents-output",
						"Usage: /subagents send <agentId> <message>",
						{ command: "send", agentId },
					);
					return;
				}

				const sendResult = state.manager.sendFollowUp(agentId, message);
				if (!sendResult.ok) {
					sendSessionMessage(
						pi,
						"pi-nexus-subagents-output",
						`Failed to send follow-up to ${agentId}: ${sendResult.error}`,
						{ command: "send", agentId },
					);
					return;
				}

				const snapshot = findSnapshot(state, agentId);
				sendSessionMessage(
					pi,
					"pi-nexus-subagents-output",
					snapshot
						? buildAgentActionText(
							`Queued follow-up for ${agentId}.`,
							snapshot,
							effectiveOptions.now(),
							["Message", message],
						)
						: `Queued follow-up for ${agentId}.\nMessage: ${message}`,
					{ command: "send", agentId },
				);
				return;
			}

			sendSessionMessage(
				pi,
				"pi-nexus-subagents-output",
				"Usage:\n/subagents\n/subagents list\n/subagents open <agentId> [peek|follow|take_over]\n/subagents send <agentId> <message>",
				{ command: "usage" },
			);
		},
	});
}

export const __testing = {
	buildSnapshotSummaryLines,
	renderBrowserLines,
	renderWorkspaceLines,
};

export default function parentExtension(pi: ExtensionApiLike): void {
	installParentExtension(pi);
}
