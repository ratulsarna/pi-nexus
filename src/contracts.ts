import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export type TmuxMode = "pane" | "window";

export type RuntimeState =
	| "starting"
	| "connecting"
	| "ready"
	| "running"
	| "waiting"
	| "needs_input"
	| "failed"
	| "stopped";

export type RuntimeChildMode = "interactive-cli";

export type ParentControlKind = "hello" | "steer" | "follow_up" | "interrupt" | "ping";
export type ReportKind = "progress" | "final_result" | "needs_input";
export const BOOTSTRAP_CONFIG_ENV_VAR = "PI_SUBAGENT_BOOTSTRAP_CONFIG";

export interface RuntimeBootstrapConfig {
	agentId: string;
	sessionPath: string;
	socketPath: string;
	tmuxMode: TmuxMode;
	tmuxTarget: string;
	initialPrompt: string;
	bootstrapExtensionPath: string;
	cwd: string;
	childMode: RuntimeChildMode;
}

export interface RuntimeLaunchSpec {
	agentId: string;
	initialPrompt: string;
	command: string;
	args: string[];
	env: Readonly<Record<string, string>>;
	cwd: string;
	sessionPath: string;
	socketPath: string;
	tmuxMode: TmuxMode;
	tmuxTarget: string;
	bootstrapConfigPath: string;
	bootstrapExtensionPath: string;
	childMode: RuntimeChildMode;
}

export interface ExplicitReport<TData = unknown> {
	kind: ReportKind;
	summary: string;
	data?: TData | null;
	reportedAt: string;
}

export interface UserIntervenedMetadata {
	source: "tmux";
	mode: "direct-chat";
	inputSource: "interactive-user";
	recordedAt: string;
}

export interface RuntimeFailure {
	message: string;
	recordedAt: string;
	fatal: boolean;
}

export type SubagentFocusAvailability = "live" | "degraded" | "stopped";

export interface SubagentFocusTarget {
	agentId: string;
	availability: SubagentFocusAvailability;
	tmuxMode: TmuxMode;
	tmuxTarget: string;
	sessionPath: string;
	focusCommand: string;
	note?: string;
}

export interface SubagentRecord<TData = unknown> {
	id: string;
	type: string;
	description: string;
	state: RuntimeState;
	tmuxMode: TmuxMode;
	tmuxTarget: string;
	sessionPath: string;
	socketPath: string;
	childMode: RuntimeChildMode;
	createdAt: string;
	startedAt?: string;
	stoppedAt?: string;
	connectedAt?: string;
	degradedAt?: string;
	assumptionsStaleAt?: string;
	userIntervenedHistory?: UserIntervenedMetadata[];
	lastProgressReport?: ExplicitReport<TData>;
	pendingInputRequest?: ExplicitReport<TData> & { kind: "needs_input" };
	finalResult?: ExplicitReport<TData> & { kind: "final_result" };
	finalResultHistory?: Array<ExplicitReport<TData> & { kind: "final_result" }>;
	error?: RuntimeFailure;
}

export interface ReportToParentInput<TData = unknown> {
	kind: ReportKind;
	summary: string;
	data?: TData | null;
}

export interface SidecarHelloPayload {
	sessionPath: string;
	tmuxTarget: string;
	mode: TmuxMode;
}

export interface SidecarSteerPayload {
	message: string;
}

export interface SidecarFollowUpPayload {
	message: string;
}

export interface SidecarReadyPayload {
	pid: number;
	sessionPath: string;
	tmuxTarget: string;
}

export interface SidecarProgressPayload<TData = unknown> {
	summary: string;
	data: TData | null;
}

export interface SidecarFinalResultPayload<TData = unknown> {
	summary: string;
	data: TData | null;
}

export interface SidecarNeedsInputPayload {
	question: string;
	kind: string;
}

export interface SidecarUserIntervenedPayload {
	source: "tmux";
	mode: "direct-chat";
}

export type SidecarStateStatus =
	| "starting"
	| "running"
	| "waiting"
	| "needs_input"
	| "failed"
	| "stopped";

export interface SidecarStatePayload {
	status: SidecarStateStatus;
}

export interface SidecarErrorPayload {
	message: string;
	fatal: boolean;
}

export type SidecarEmptyPayload = Record<string, never>;

export interface SidecarPayloadByType<TData = unknown> {
	hello: SidecarHelloPayload;
	steer: SidecarSteerPayload;
	follow_up: SidecarFollowUpPayload;
	interrupt: SidecarEmptyPayload;
	ready: SidecarReadyPayload;
	progress: SidecarProgressPayload<TData>;
	final_result: SidecarFinalResultPayload<TData>;
	needs_input: SidecarNeedsInputPayload;
	user_intervened: SidecarUserIntervenedPayload;
	state: SidecarStatePayload;
	error: SidecarErrorPayload;
	ping: SidecarEmptyPayload;
	pong: SidecarEmptyPayload;
}

export type SidecarMessageKind = keyof SidecarPayloadByType;
export type SidecarEventKind = Exclude<SidecarMessageKind, ParentControlKind>;

export interface SidecarEnvelope<TType extends SidecarMessageKind = SidecarMessageKind, TData = unknown> {
	version: 1;
	agentId: string;
	type: TType;
	seq: number;
	time: string;
	payload: SidecarPayloadByType<TData>[TType];
}

export type SidecarProtocolMessage<TData = unknown> = {
	[TType in SidecarMessageKind]: SidecarEnvelope<TType, TData>;
}[SidecarMessageKind];

export type SidecarControlMessage<TData = unknown> = Extract<SidecarProtocolMessage<TData>, { type: ParentControlKind }>;
export type SidecarEventMessage<TData = unknown> = Extract<SidecarProtocolMessage<TData>, { type: SidecarEventKind }>;

export interface SidecarHandshakeIdentity {
	agentId: string;
	sessionPath: string;
}

export interface SidecarHandshake {
	hello: SidecarEnvelope<"hello">;
	ready: SidecarEnvelope<"ready">;
}

export type ChildInputOrigin =
	| "interactive-user"
	| "parent-steer"
	| "parent-follow_up"
	| "extension"
	| "system";

export interface ChildInputEvent {
	origin: ChildInputOrigin;
	submitted: boolean;
}

export interface ValidationResult<T> {
	ok: true;
	value: T;
}

export interface ValidationError {
	ok: false;
	error: string;
}

export type ValidationOutcome<T> = ValidationResult<T> | ValidationError;

const RUNTIME_STATE_TRANSITIONS: Record<RuntimeState, readonly RuntimeState[]> = {
	starting: ["connecting", "failed", "stopped"],
	connecting: ["ready", "failed", "stopped"],
	ready: ["running", "waiting", "needs_input", "failed", "stopped"],
	running: ["waiting", "needs_input", "failed", "stopped"],
	waiting: ["running", "needs_input", "failed", "stopped"],
	needs_input: ["running", "waiting", "failed", "stopped"],
	failed: ["running", "waiting", "needs_input", "stopped"],
	stopped: [],
};

const TERMINAL_STATES = new Set<RuntimeState>(["stopped"]);
const RUNTIME_STATES = new Set<RuntimeState>([
	"starting",
	"connecting",
	"ready",
	"running",
	"waiting",
	"needs_input",
	"failed",
	"stopped",
]);
const REPORT_KINDS = new Set<ReportKind>(["progress", "final_result", "needs_input"]);
const SIDECAR_CONTROL_MESSAGE_KINDS: ReadonlyArray<ParentControlKind> = [
	"hello",
	"steer",
	"follow_up",
	"interrupt",
	"ping",
];
const SIDECAR_EVENT_MESSAGE_KINDS: ReadonlyArray<SidecarEventKind> = [
	"ready",
	"progress",
	"final_result",
	"needs_input",
	"user_intervened",
	"state",
	"error",
	"pong",
];
const SIDECAR_MESSAGE_KINDS: ReadonlyArray<SidecarMessageKind> = [
	...SIDECAR_CONTROL_MESSAGE_KINDS,
	...SIDECAR_EVENT_MESSAGE_KINDS,
];
const SIDECAR_MESSAGE_KIND_SET = new Set<SidecarMessageKind>(SIDECAR_MESSAGE_KINDS);
const SIDECAR_CONTROL_MESSAGE_KIND_SET = new Set<ParentControlKind>(SIDECAR_CONTROL_MESSAGE_KINDS);
const SIDECAR_EVENT_MESSAGE_KIND_SET = new Set<SidecarEventKind>(SIDECAR_EVENT_MESSAGE_KINDS);
const SIDECAR_STATE_STATUSES = new Set<SidecarStateStatus>([
	"starting",
	"running",
	"waiting",
	"needs_input",
	"failed",
	"stopped",
]);
const SIDECAR_EMPTY_PAYLOAD_TYPES = new Set<SidecarMessageKind>(["interrupt", "ping", "pong"]);
const SUBAGENT_FOCUS_AVAILABILITIES = new Set<SubagentFocusAvailability>(["live", "degraded", "stopped"]);
const STATES_REQUIRING_CONNECTED_AT = new Set<RuntimeState>([
	"ready",
	"running",
	"waiting",
	"needs_input",
]);
const PRE_HANDSHAKE_STATES = new Set<RuntimeState>(["starting", "connecting"]);
const REPORT_REJECTED_STATES = new Set<RuntimeState>(["starting", "connecting", "stopped"]);

function isNonEmptyTrimmedString(value: unknown): value is string {
	if (typeof value !== "string") return false;
	return value.trim().length > 0;
}

function isAbsolutePathLike(value: string): boolean {
	return value.startsWith("/");
}

function isIsoTimestamp(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
		return false;
	}

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return false;
	}

	return parsed.toISOString() === value;
}

export function isRuntimeState(value: string): value is RuntimeState {
	return RUNTIME_STATES.has(value as RuntimeState);
}

function fail(error: string): ValidationError {
	return { ok: false, error };
}

function ok<T>(value: T): ValidationResult<T> {
	return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && !Array.isArray(value);
}

function getParentProcessEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

function isEnvRecord(value: unknown): value is Readonly<Record<string, string>> {
	if (!isRecord(value)) return false;

	return Object.entries(value).every(
		([key, entry]) => typeof key === "string" && !key.includes("\0") && typeof entry === "string" && !entry.includes("\0"),
	);
}

function isAbsoluteCommandPath(value: string): boolean {
	return path.isAbsolute(value);
}

function isTimestampOnOrBefore(left: string, right: string): boolean {
	return left <= right;
}

function hasOwnField(record: Record<string, unknown>, field: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, field);
}

function canExecutePath(filePath: string): boolean {
	try {
		if (!fs.statSync(filePath).isFile()) {
			return false;
		}
		fs.accessSync(filePath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function isExistingDirectory(dirPath: string): boolean {
	try {
		return fs.statSync(dirPath).isDirectory();
	} catch {
		return false;
	}
}

function isExistingFile(filePath: string): boolean {
	try {
		return fs.statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function isExistingNonFile(filePath: string): boolean {
	try {
		const stats = fs.lstatSync(filePath);
		if (stats.isSymbolicLink()) {
			try {
				return !fs.statSync(filePath).isFile();
			} catch {
				return true;
			}
		}
		return !stats.isFile() && !stats.isDirectory();
	} catch {
		return false;
	}
}

function pathExists(filePath: string): boolean {
	try {
		fs.lstatSync(filePath);
		return true;
	} catch {
		return false;
	}
}

function isExistingSocket(filePath: string): boolean {
	try {
		return fs.lstatSync(filePath).isSocket();
	} catch {
		return false;
	}
}

function isReachableUnixSocket(filePath: string): boolean {
	const probe = spawnSync(
		process.execPath,
		[
			"-e",
			`
const net = require("node:net");
const socketPath = process.argv[1];
const socket = net.createConnection(socketPath);
socket.once("connect", () => {
	socket.end();
	process.exit(0);
});
socket.once("error", () => {
	process.exit(1);
});
setTimeout(() => {
	process.exit(2);
}, 200);
`,
			filePath,
		],
		{
			stdio: "ignore",
			timeout: 500,
		},
	);

	return probe.status === 0;
}

function normalizeOptionalData<TData>(record: Record<string, unknown>): TData | null {
	if (!hasOwnField(record, "data") || record.data === undefined) {
		return null;
	}

	return record.data as TData | null;
}

function isExistingDirectoryPath(value: string): boolean {
	try {
		return fs.statSync(value).isDirectory();
	} catch {
		return false;
	}
}

function readJsonFile(filePath: string): ValidationOutcome<unknown> {
	try {
		return ok(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return fail(`bootstrapConfigPath must contain valid JSON: ${reason}`);
	}
}

function validateBootstrapConfigMatches(
	bootstrapConfig: RuntimeBootstrapConfig,
	expected: RuntimeBootstrapConfig,
	expectedLabel: string,
): ValidationError | undefined {
	const fields: ReadonlyArray<keyof RuntimeBootstrapConfig> = [
		"agentId",
		"sessionPath",
		"socketPath",
		"tmuxMode",
		"tmuxTarget",
		"initialPrompt",
		"bootstrapExtensionPath",
		"cwd",
		"childMode",
	];

	for (const field of fields) {
		if (bootstrapConfig[field] !== expected[field]) {
			return fail(`bootstrap config ${field} must match ${expectedLabel} ${field}`);
		}
	}

	return undefined;
}

function validateDistinctPaths(paths: ReadonlyArray<[label: string, value: string]>): ValidationError | undefined {
	for (let i = 0; i < paths.length; i += 1) {
		const [leftLabel, leftValue] = paths[i];
		const leftCanonical = getCanonicalPathIdentity(leftValue);
		for (let j = i + 1; j < paths.length; j += 1) {
			const [rightLabel, rightValue] = paths[j];
			const rightCanonical = getCanonicalPathIdentity(rightValue);
			if (leftCanonical === rightCanonical) {
				return fail(`${leftLabel} must not equal ${rightLabel}`);
			}
		}
	}

	return undefined;
}

function resolveExecutablePath(
	command: string,
	env: Readonly<Record<string, string>>,
	cwd: string,
): ValidationOutcome<string> {
	if (isAbsoluteCommandPath(command)) {
		if (!canExecutePath(command)) {
			return fail(`command is not executable: ${command}`);
		}

		return ok(command);
	}

	const pathValue = env.PATH;
	const pathError = validateRequiredText("env.PATH", pathValue);
	if (pathError) return pathError;

	for (const directory of pathValue.split(path.delimiter)) {
		const candidate = directory.length === 0
			? path.resolve(cwd, command)
			: path.isAbsolute(directory)
				? path.resolve(directory, command)
				: path.resolve(cwd, directory, command);
		if (canExecutePath(candidate)) {
			return ok(candidate);
		}
	}

	return fail(`command could not be resolved from env.PATH: ${command}`);
}

function validateLaunchEnvironment(
	command: string,
	env: Readonly<Record<string, string>>,
): ValidationError | undefined {
	const homeError = validateRequiredPath("env.HOME", env.HOME);
	if (homeError) return homeError;

	return undefined;
}

function getCanonicalPathIdentity(filePath: string): string {
	const resolvedPath = path.resolve(filePath);

	try {
		return fs.realpathSync.native(resolvedPath);
	} catch {
		const parentDir = path.dirname(resolvedPath);
		try {
			const canonicalParent = fs.realpathSync.native(parentDir);
			return path.join(canonicalParent, path.basename(resolvedPath));
		} catch {
			return resolvedPath;
		}
	}
}

function validateRequiredPath(field: string, value: unknown): ValidationError | undefined {
	if (!isNonEmptyTrimmedString(value)) return fail(`${field} must be a non-empty string`);
	if (!isAbsolutePathLike(value)) return fail(`${field} must be an absolute path`);
	return undefined;
}

function validateRequiredText(field: string, value: unknown): ValidationError | undefined {
	if (!isNonEmptyTrimmedString(value)) return fail(`${field} must be a non-empty string`);
	return undefined;
}

function validateNonNegativeSafeInteger(field: string, value: unknown): ValidationError | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
		return fail(`${field} must be a non-negative safe integer`);
	}
	return undefined;
}

export function validateRuntimeBootstrapConfig(input: unknown): ValidationOutcome<RuntimeBootstrapConfig> {
	if (!isRecord(input)) {
		return fail("bootstrap config must be an object");
	}

	const idError = validateRequiredText("agentId", input.agentId);
	if (idError) return idError;

	const cwdError = validateRequiredPath("cwd", input.cwd);
	if (cwdError) return cwdError;

	const sessionError = validateRequiredPath("sessionPath", input.sessionPath);
	if (sessionError) return sessionError;

	const socketError = validateRequiredPath("socketPath", input.socketPath);
	if (socketError) return socketError;

	const extensionError = validateRequiredPath("bootstrapExtensionPath", input.bootstrapExtensionPath);
	if (extensionError) return extensionError;
	if (!isExistingDirectory(input.cwd as string)) {
		return fail("cwd must exist and be a directory");
	}
	if (!isExistingDirectory(path.dirname(input.sessionPath as string))) {
		return fail("sessionPath parent directory must exist");
	}
	if (!isExistingDirectory(path.dirname(input.socketPath as string))) {
		return fail("socketPath parent directory must exist");
	}
	if (isExistingDirectoryPath(input.sessionPath as string)) {
		return fail("sessionPath must not be an existing directory");
	}
	if (isExistingNonFile(input.sessionPath as string)) {
		return fail("sessionPath must not be an existing non-file path");
	}
	if (isExistingDirectoryPath(input.socketPath as string)) {
		return fail("socketPath must not be an existing directory");
	}
	if (pathExists(input.socketPath as string) && !isExistingSocket(input.socketPath as string)) {
		return fail("socketPath must not already exist");
	}
	if (isExistingSocket(input.socketPath as string) && !isReachableUnixSocket(input.socketPath as string)) {
		return fail("socketPath must not be a stale unix socket");
	}
	if (!isExistingFile(input.bootstrapExtensionPath as string)) {
		return fail("bootstrapExtensionPath must exist and be a file");
	}
	const distinctPathError = validateDistinctPaths([
		["sessionPath", input.sessionPath as string],
		["socketPath", input.socketPath as string],
		["bootstrapExtensionPath", input.bootstrapExtensionPath as string],
	]);
	if (distinctPathError) return distinctPathError;

	const tmuxTargetError = validateRequiredText("tmuxTarget", input.tmuxTarget);
	if (tmuxTargetError) return tmuxTargetError;

	const promptError = validateRequiredText("initialPrompt", input.initialPrompt);
	if (promptError) return promptError;

	if (input.tmuxMode !== "pane" && input.tmuxMode !== "window") {
		return fail("tmuxMode must be either \"pane\" or \"window\"");
	}

	if (input.childMode !== "interactive-cli") {
		return fail("childMode must be \"interactive-cli\"");
	}

	return ok({
		agentId: input.agentId as string,
		sessionPath: input.sessionPath as string,
		socketPath: input.socketPath as string,
		tmuxMode: input.tmuxMode,
		tmuxTarget: input.tmuxTarget as string,
		initialPrompt: input.initialPrompt as string,
		bootstrapExtensionPath: input.bootstrapExtensionPath as string,
		cwd: input.cwd as string,
		childMode: input.childMode,
	});
}

export function createRuntimeLaunchSpec(
	bootstrap: unknown,
	bootstrapConfigPath: string,
): ValidationOutcome<RuntimeLaunchSpec> {
	const bootstrapResult = validateRuntimeBootstrapConfig(bootstrap);
	if (!bootstrapResult.ok) return bootstrapResult;

	const configPathError = validateRequiredPath("bootstrapConfigPath", bootstrapConfigPath);
	if (configPathError) return configPathError;
	if (!isExistingFile(bootstrapConfigPath)) {
		return fail("bootstrapConfigPath must exist and be a file");
	}

	const bootstrapConfig = bootstrapResult.value;
	const bootstrapFileResult = readJsonFile(bootstrapConfigPath);
	if (!bootstrapFileResult.ok) return bootstrapFileResult;
	const bootstrapFileValidation = validateRuntimeBootstrapConfig(bootstrapFileResult.value);
	if (!bootstrapFileValidation.ok) {
		return fail(`bootstrapConfigPath contents are invalid: ${bootstrapFileValidation.error}`);
	}
	const bootstrapFileMatchError = validateBootstrapConfigMatches(
		bootstrapFileValidation.value,
		bootstrapConfig,
		"provided bootstrap config",
	);
	if (bootstrapFileMatchError) return bootstrapFileMatchError;
	const distinctPathError = validateDistinctPaths([
		["sessionPath", bootstrapConfig.sessionPath],
		["socketPath", bootstrapConfig.socketPath],
		["bootstrapConfigPath", bootstrapConfigPath],
		["bootstrapExtensionPath", bootstrapConfig.bootstrapExtensionPath],
	]);
	if (distinctPathError) return distinctPathError;

	const env = {
		...getParentProcessEnv(),
		[BOOTSTRAP_CONFIG_ENV_VAR]: bootstrapConfigPath,
	};
	const envError = validateLaunchEnvironment("pi", env);
	if (envError) return envError;
	const resolvedCommandResult = resolveExecutablePath("pi", env, bootstrapConfig.cwd);
	if (!resolvedCommandResult.ok) return resolvedCommandResult;

	return ok({
		agentId: bootstrapConfig.agentId,
		initialPrompt: bootstrapConfig.initialPrompt,
		command: resolvedCommandResult.value,
		args: ["--session", bootstrapConfig.sessionPath, "--extension", bootstrapConfig.bootstrapExtensionPath],
		env,
		cwd: bootstrapConfig.cwd,
		sessionPath: bootstrapConfig.sessionPath,
		socketPath: bootstrapConfig.socketPath,
		tmuxMode: bootstrapConfig.tmuxMode,
		tmuxTarget: bootstrapConfig.tmuxTarget,
		bootstrapConfigPath,
		bootstrapExtensionPath: bootstrapConfig.bootstrapExtensionPath,
		childMode: bootstrapConfig.childMode,
	});
}

export function validateRuntimeLaunchSpec(input: unknown): ValidationOutcome<RuntimeLaunchSpec> {
	if (!isRecord(input)) {
		return fail("launch spec must be an object");
	}

	const agentIdError = validateRequiredText("agentId", input.agentId);
	if (agentIdError) return agentIdError;
	const initialPromptError = validateRequiredText("initialPrompt", input.initialPrompt);
	if (initialPromptError) return initialPromptError;

	if (!isNonEmptyTrimmedString(input.command)) {
		return fail("command must be a non-empty string");
	}
	if (!isAbsoluteCommandPath(input.command)) {
		return fail("command must be an absolute path");
	}
	if (path.basename(input.command) !== "pi") {
		return fail("command must resolve to pi");
	}
	if (!Array.isArray(input.args)) {
		return fail("args must be an array");
	}
	if (!isEnvRecord(input.env)) {
		return fail("env must be a string-to-string map");
	}

	const cwdError = validateRequiredPath("cwd", input.cwd);
	if (cwdError) return cwdError;

	const sessionError = validateRequiredPath("sessionPath", input.sessionPath);
	if (sessionError) return sessionError;

	const socketError = validateRequiredPath("socketPath", input.socketPath);
	if (socketError) return socketError;

	const configPathError = validateRequiredPath("bootstrapConfigPath", input.bootstrapConfigPath);
	if (configPathError) return configPathError;
	const bootstrapExtensionPathError = validateRequiredPath("bootstrapExtensionPath", input.bootstrapExtensionPath);
	if (bootstrapExtensionPathError) return bootstrapExtensionPathError;
	const bootstrapConfigPath = input.bootstrapConfigPath as string;
	if (!isExistingFile(bootstrapConfigPath)) {
		return fail("bootstrapConfigPath must exist and be a file");
	}
	const cwd = input.cwd as string;
	const sessionPath = input.sessionPath as string;
	const socketPath = input.socketPath as string;
	const bootstrapExtensionPath = input.bootstrapExtensionPath as string;
	if (!canExecutePath(input.command)) {
		return fail(`command is not executable: ${input.command}`);
	}
	if (!isExistingDirectory(cwd)) {
		return fail("cwd must exist and be a directory");
	}
	if (!isExistingDirectory(path.dirname(sessionPath))) {
		return fail("sessionPath parent directory must exist");
	}
	if (!isExistingDirectory(path.dirname(socketPath))) {
		return fail("socketPath parent directory must exist");
	}
	if (isExistingDirectoryPath(sessionPath)) {
		return fail("sessionPath must not be an existing directory");
	}
	if (isExistingNonFile(sessionPath)) {
		return fail("sessionPath must not be an existing non-file path");
	}
	if (isExistingDirectoryPath(socketPath)) {
		return fail("socketPath must not be an existing directory");
	}
	if (pathExists(socketPath) && !isExistingSocket(socketPath)) {
		return fail("socketPath must not already exist");
	}
	if (!isExistingFile(bootstrapExtensionPath)) {
		return fail("bootstrapExtensionPath must exist and be a file");
	}
	if (isExistingSocket(socketPath) && !isReachableUnixSocket(socketPath)) {
		return fail("socketPath must not be a stale unix socket");
	}
	const distinctPathError = validateDistinctPaths([
		["sessionPath", sessionPath],
		["socketPath", socketPath],
		["bootstrapConfigPath", bootstrapConfigPath],
		["bootstrapExtensionPath", bootstrapExtensionPath],
	]);
	if (distinctPathError) return distinctPathError;

	if (input.args.length !== 4) return fail("args must be: --session <sessionPath> --extension <extensionPath>");
	if (input.args[0] !== "--session") {
		return fail("args[0] must be --session");
	}
	if (input.args[1] !== input.sessionPath) {
		return fail("args[1] must match sessionPath");
	}
	if (input.args[2] !== "--extension") {
		return fail("args[2] must be --extension");
	}
	const extensionArgError = validateRequiredPath("args[3]", input.args[3]);
	if (extensionArgError) return extensionArgError;
	if (input.args[3] !== input.bootstrapExtensionPath) {
		return fail("args[3] must match bootstrapExtensionPath");
	}
	const bootstrapEnvPath = input.env[BOOTSTRAP_CONFIG_ENV_VAR];
	const bootstrapEnvError = validateRequiredPath(BOOTSTRAP_CONFIG_ENV_VAR, bootstrapEnvPath);
	if (bootstrapEnvError) return bootstrapEnvError;
	if (bootstrapEnvPath !== input.bootstrapConfigPath) {
		return fail(`${BOOTSTRAP_CONFIG_ENV_VAR} must match bootstrapConfigPath`);
	}
	const envError = validateLaunchEnvironment(input.command, input.env);
	if (envError) return envError;
	if (input.tmuxMode !== "pane" && input.tmuxMode !== "window") {
		return fail("tmuxMode must be either \"pane\" or \"window\"");
	}
	if (!isNonEmptyTrimmedString(input.tmuxTarget)) return fail("tmuxTarget must be a non-empty string");
	if (input.childMode !== "interactive-cli") return fail("childMode must be \"interactive-cli\"");

	const bootstrapConfigResult = readJsonFile(bootstrapConfigPath);
	if (!bootstrapConfigResult.ok) return bootstrapConfigResult;
	const bootstrapValidation = validateRuntimeBootstrapConfig(bootstrapConfigResult.value);
	if (!bootstrapValidation.ok) {
		return fail(`bootstrapConfigPath contents are invalid: ${bootstrapValidation.error}`);
	}
	const bootstrapMatchError = validateBootstrapConfigMatches(
		bootstrapValidation.value,
		{
			agentId: input.agentId as string,
			sessionPath,
			socketPath,
			tmuxMode: input.tmuxMode,
			tmuxTarget: input.tmuxTarget,
			initialPrompt: input.initialPrompt as string,
			bootstrapExtensionPath,
			cwd,
			childMode: input.childMode,
		},
		"launch spec",
	);
	if (bootstrapMatchError) return bootstrapMatchError;

	const launchSpec: RuntimeLaunchSpec = {
		agentId: input.agentId as string,
		initialPrompt: input.initialPrompt as string,
		command: input.command,
		args: input.args.map((arg) => String(arg)),
		env: input.env,
		cwd,
		sessionPath,
		socketPath,
		tmuxMode: input.tmuxMode,
		tmuxTarget: input.tmuxTarget,
		bootstrapConfigPath,
		bootstrapExtensionPath,
		childMode: input.childMode,
	};

	return ok(launchSpec);
}

export function canTransitionRuntimeState(from: RuntimeState, to: RuntimeState): boolean {
	return RUNTIME_STATE_TRANSITIONS[from].includes(to);
}

export function assertRuntimeStateTransition(from: RuntimeState, to: RuntimeState): ValidationOutcome<RuntimeState> {
	if (!canTransitionRuntimeState(from, to)) {
		return fail(`invalid runtime state transition: ${from} -> ${to}`);
	}

	return ok(to);
}

export function isTerminalRuntimeState(state: RuntimeState): boolean {
	return TERMINAL_STATES.has(state);
}

function validateExplicitReport<TData = unknown>(
	field: string,
	report: unknown,
	expectedKind?: ReportKind,
): ValidationOutcome<ExplicitReport<TData>> {
	if (!isRecord(report)) {
		return fail(`${field} must be an object`);
	}
	const kind = report.kind;
	if (!REPORT_KINDS.has(kind as ReportKind)) {
		return fail(`${field}.kind must be one of: progress, final_result, needs_input`);
	}
	if (expectedKind && kind !== expectedKind) {
		return fail(`${field}.kind must be ${expectedKind}`);
	}
	const summaryError = validateRequiredText(`${field}.summary`, report.summary);
	if (summaryError) return summaryError;
	const reportedAt = report.reportedAt;
	if (typeof reportedAt !== "string" || !isIsoTimestamp(reportedAt)) {
		return fail(`${field}.reportedAt must be an ISO timestamp`);
	}
	const summary = report.summary as string;

	return ok({
		kind: kind as ReportKind,
		summary: summary.trim(),
		data: normalizeOptionalData<TData>(report),
		reportedAt,
	});
}

function validateUserIntervenedMetadata(
	metadata: unknown,
): ValidationOutcome<UserIntervenedMetadata> {
	if (!isRecord(metadata)) {
		return fail("userIntervened must be an object");
	}
	if (metadata.source !== "tmux") {
		return fail("userIntervened.source must be tmux");
	}
	if (metadata.mode !== "direct-chat") {
		return fail("userIntervened.mode must be direct-chat");
	}
	if (metadata.inputSource !== "interactive-user") {
		return fail("userIntervened.inputSource must be interactive-user");
	}
	const recordedAt = metadata.recordedAt;
	if (typeof recordedAt !== "string" || !isIsoTimestamp(recordedAt)) {
		return fail("userIntervened.recordedAt must be an ISO timestamp");
	}

	return ok({
		source: metadata.source,
		mode: metadata.mode,
		inputSource: metadata.inputSource,
		recordedAt,
	});
}

function prefixNestedValidationError(field: string, nestedField: string, error: string): string {
	if (error === `${nestedField} must be an object`) {
		return `${field} must be an object`;
	}
	if (error.startsWith(`${nestedField}.`)) {
		return `${field}.${error.slice(nestedField.length + 1)}`;
	}
	return `${field} ${error}`;
}

function describeThrownError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	try {
		return String(error);
	} catch {
		return "unknown error";
	}
}

function safeDeepStrictEqual(field: string, left: unknown, right: unknown): ValidationOutcome<boolean> {
	try {
		return ok(isDeepStrictEqual(left, right));
	} catch (error) {
		const reason = describeThrownError(error);
		return fail(`${field} must be comparable: ${reason}`);
	}
}

function validateRuntimeFailure(error: unknown): ValidationOutcome<RuntimeFailure> {
	if (!isRecord(error)) {
		return fail("error must be an object");
	}
	const messageError = validateRequiredText("error.message", error.message);
	if (messageError) return messageError;
	const recordedAt = error.recordedAt;
	if (typeof recordedAt !== "string" || !isIsoTimestamp(recordedAt)) {
		return fail("error.recordedAt must be an ISO timestamp");
	}
	const fatal = error.fatal;
	if (typeof fatal !== "boolean") {
		return fail("error.fatal must be a boolean");
	}
	const message = error.message as string;

	return ok({
		message: message.trim(),
		recordedAt,
		fatal,
	});
}

export function validateReportToParentInput<TData = unknown>(
	input: unknown,
	currentState?: RuntimeState,
): ValidationOutcome<ReportToParentInput<TData>> {
	if (!isRecord(input)) {
		return fail("report must be an object");
	}
	const kind = input.kind;
	if (!REPORT_KINDS.has(kind as ReportKind)) {
		return fail("kind must be one of: progress, final_result, needs_input");
	}

	const summaryError = validateRequiredText("summary", input.summary);
	if (summaryError) return summaryError;
	const summary = input.summary as string;

	if (currentState && REPORT_REJECTED_STATES.has(currentState)) {
		return fail(`cannot accept ${kind} report while state is ${currentState}`);
	}

	return ok({
		kind: kind as ReportKind,
		summary: summary.trim(),
		data: normalizeOptionalData<TData>(input),
	});
}

function validateSidecarPayload<TData = unknown>(
	type: SidecarMessageKind,
	payload: unknown,
): ValidationOutcome<SidecarPayloadByType<TData>[SidecarMessageKind]> {
	if (!isPlainRecord(payload)) {
		return fail(`${type}.payload must be an object`);
	}

	if (SIDECAR_EMPTY_PAYLOAD_TYPES.has(type)) {
		if (Object.keys(payload).length > 0) {
			return fail(`${type}.payload must be an empty object`);
		}
		return ok({} as SidecarEmptyPayload);
	}

	switch (type) {
		case "hello": {
			const sessionPathError = validateRequiredPath("hello.payload.sessionPath", payload.sessionPath);
			if (sessionPathError) return sessionPathError;
			const tmuxTargetError = validateRequiredText("hello.payload.tmuxTarget", payload.tmuxTarget);
			if (tmuxTargetError) return tmuxTargetError;
			if (payload.mode !== "pane" && payload.mode !== "window") {
				return fail("hello.payload.mode must be either \"pane\" or \"window\"");
			}

			return ok({
				sessionPath: payload.sessionPath as string,
				tmuxTarget: (payload.tmuxTarget as string).trim(),
				mode: payload.mode,
			});
		}
		case "steer":
		case "follow_up": {
			const messageError = validateRequiredText(`${type}.payload.message`, payload.message);
			if (messageError) return messageError;

			return ok({
				message: (payload.message as string).trim(),
			});
		}
		case "ready": {
			if (typeof payload.pid !== "number" || !Number.isSafeInteger(payload.pid) || payload.pid <= 0) {
				return fail("ready.payload.pid must be a positive safe integer");
			}
			const sessionPathError = validateRequiredPath("ready.payload.sessionPath", payload.sessionPath);
			if (sessionPathError) return sessionPathError;
			const tmuxTargetError = validateRequiredText("ready.payload.tmuxTarget", payload.tmuxTarget);
			if (tmuxTargetError) return tmuxTargetError;

			return ok({
				pid: payload.pid,
				sessionPath: payload.sessionPath as string,
				tmuxTarget: (payload.tmuxTarget as string).trim(),
			});
		}
		case "progress":
		case "final_result": {
			const summaryError = validateRequiredText(`${type}.payload.summary`, payload.summary);
			if (summaryError) return summaryError;

			return ok({
				summary: (payload.summary as string).trim(),
				data: normalizeOptionalData<TData>(payload),
			});
		}
		case "needs_input": {
			const questionError = validateRequiredText("needs_input.payload.question", payload.question);
			if (questionError) return questionError;
			const kindError = validateRequiredText("needs_input.payload.kind", payload.kind);
			if (kindError) return kindError;

			return ok({
				question: (payload.question as string).trim(),
				kind: (payload.kind as string).trim(),
			});
		}
		case "user_intervened": {
			if (payload.source !== "tmux") {
				return fail("user_intervened.payload.source must be tmux");
			}
			if (payload.mode !== "direct-chat") {
				return fail("user_intervened.payload.mode must be direct-chat");
			}

			return ok({
				source: payload.source,
				mode: payload.mode,
			});
		}
		case "state": {
			const status = payload.status;
			if (typeof status !== "string" || !SIDECAR_STATE_STATUSES.has(status as SidecarStateStatus)) {
				return fail("state.payload.status must be one of: starting, running, waiting, needs_input, failed, stopped");
			}

			return ok({
				status: status as SidecarStateStatus,
			});
		}
		case "error": {
			const messageError = validateRequiredText("error.payload.message", payload.message);
			if (messageError) return messageError;
			if (typeof payload.fatal !== "boolean") {
				return fail("error.payload.fatal must be a boolean");
			}

			return ok({
				message: (payload.message as string).trim(),
				fatal: payload.fatal,
			});
		}
		default:
			return fail(`unsupported sidecar message type: ${type}`);
	}
}

export function validateSidecarProtocolEnvelope<TData = unknown>(
	input: unknown,
): ValidationOutcome<SidecarProtocolMessage<TData>> {
	if (!isPlainRecord(input)) {
		return fail("sidecar envelope must be an object");
	}

	if (input.version !== 1) {
		return fail("sidecar envelope version must be 1");
	}

	const agentIdError = validateRequiredText("sidecar envelope agentId", input.agentId);
	if (agentIdError) return agentIdError;

	const type = input.type;
	if (typeof type !== "string" || !SIDECAR_MESSAGE_KIND_SET.has(type as SidecarMessageKind)) {
		return fail(`sidecar envelope type must be one of: ${SIDECAR_MESSAGE_KINDS.join(", ")}`);
	}

	const seqError = validateNonNegativeSafeInteger("sidecar envelope seq", input.seq);
	if (seqError) return seqError;

	if (typeof input.time !== "string" || !isIsoTimestamp(input.time)) {
		return fail("sidecar envelope time must be an ISO timestamp");
	}

	if (!hasOwnField(input, "payload")) {
		return fail("sidecar envelope payload is required");
	}

	const payloadResult = validateSidecarPayload<TData>(type as SidecarMessageKind, input.payload);
	if (!payloadResult.ok) return payloadResult;

	return ok({
		version: 1,
		agentId: (input.agentId as string).trim(),
		type: type as SidecarMessageKind,
		seq: input.seq,
		time: input.time,
		payload: payloadResult.value,
	} as SidecarProtocolMessage<TData>);
}

export function validateSidecarControlMessage<TData = unknown>(
	input: unknown,
): ValidationOutcome<SidecarControlMessage<TData>> {
	const envelopeResult = validateSidecarProtocolEnvelope<TData>(input);
	if (!envelopeResult.ok) return envelopeResult;
	if (!SIDECAR_CONTROL_MESSAGE_KIND_SET.has(envelopeResult.value.type as ParentControlKind)) {
		return fail(`sidecar control message type must be one of: ${SIDECAR_CONTROL_MESSAGE_KINDS.join(", ")}`);
	}

	return ok(envelopeResult.value as SidecarControlMessage<TData>);
}

export function validateSidecarEventMessage<TData = unknown>(
	input: unknown,
): ValidationOutcome<SidecarEventMessage<TData>> {
	const envelopeResult = validateSidecarProtocolEnvelope<TData>(input);
	if (!envelopeResult.ok) return envelopeResult;
	if (!SIDECAR_EVENT_MESSAGE_KIND_SET.has(envelopeResult.value.type as SidecarEventKind)) {
		return fail(`sidecar event message type must be one of: ${SIDECAR_EVENT_MESSAGE_KINDS.join(", ")}`);
	}

	return ok(envelopeResult.value as SidecarEventMessage<TData>);
}

function validateSidecarHandshakeIdentity(input: unknown): ValidationOutcome<SidecarHandshakeIdentity> {
	if (!isPlainRecord(input)) {
		return fail("handshake identity must be an object");
	}

	const agentIdError = validateRequiredText("handshake agentId", input.agentId);
	if (agentIdError) return agentIdError;

	const sessionPathError = validateRequiredPath("handshake sessionPath", input.sessionPath);
	if (sessionPathError) return sessionPathError;

	return ok({
		agentId: (input.agentId as string).trim(),
		sessionPath: input.sessionPath as string,
	});
}

function validateHandshakeMessageIdentity(
	step: "hello" | "ready",
	message: SidecarEnvelope<"hello"> | SidecarEnvelope<"ready">,
	identity: SidecarHandshakeIdentity,
): ValidationError | undefined {
	if (message.agentId !== identity.agentId) {
		return fail(`${step} agentId must match handshake agentId`);
	}

	if (message.payload.sessionPath !== identity.sessionPath) {
		return fail(`${step} sessionPath must match handshake sessionPath`);
	}
}

export function validateSidecarHandshake(
	helloInput: unknown,
	readyInput: unknown,
	expectedIdentity: unknown,
): ValidationOutcome<SidecarHandshake> {
	const identityResult = validateSidecarHandshakeIdentity(expectedIdentity);
	if (!identityResult.ok) return identityResult;

	const helloResult = validateSidecarProtocolEnvelope(helloInput);
	if (!helloResult.ok) return helloResult;
	if (helloResult.value.type !== "hello") {
		return fail("handshake first message must be hello");
	}

	const hello = helloResult.value as SidecarEnvelope<"hello">;
	const helloIdentityError = validateHandshakeMessageIdentity("hello", hello, identityResult.value);
	if (helloIdentityError) return helloIdentityError;

	const readyResult = validateSidecarProtocolEnvelope(readyInput);
	if (!readyResult.ok) return readyResult;
	if (readyResult.value.type !== "ready") {
		return fail("handshake second message must be ready");
	}

	const ready = readyResult.value as SidecarEnvelope<"ready">;
	const readyIdentityError = validateHandshakeMessageIdentity("ready", ready, identityResult.value);
	if (readyIdentityError) return readyIdentityError;

	return ok({ hello, ready });
}

export function validateMonotonicSeqAcceptance(seq: unknown, lastAcceptedSeq?: unknown): ValidationOutcome<number> {
	const seqError = validateNonNegativeSafeInteger("seq", seq);
	if (seqError) return seqError;

	const normalizedSeq = seq as number;

	if (lastAcceptedSeq === undefined) {
		return ok(normalizedSeq);
	}

	const lastAcceptedSeqError = validateNonNegativeSafeInteger("lastAcceptedSeq", lastAcceptedSeq);
	if (lastAcceptedSeqError) return lastAcceptedSeqError;

	const normalizedLastAcceptedSeq = lastAcceptedSeq as number;
	if (normalizedSeq === normalizedLastAcceptedSeq) {
		return fail("seq must be greater than lastAcceptedSeq (duplicate seq)");
	}
	if (normalizedSeq < normalizedLastAcceptedSeq) {
		return fail("seq must be greater than lastAcceptedSeq (stale or out-of-order seq)");
	}

	return ok(normalizedSeq);
}

export function shouldEmitUserIntervened(event: ChildInputEvent): boolean {
	return event.origin === "interactive-user" && event.submitted;
}

export function createUserIntervenedMetadata(recordedAt: string): ValidationOutcome<UserIntervenedMetadata> {
	if (!isIsoTimestamp(recordedAt)) {
		return fail("recordedAt must be an ISO timestamp");
	}

	return ok({
		source: "tmux",
		mode: "direct-chat",
		inputSource: "interactive-user",
		recordedAt,
	});
}

export function validateSubagentFocusTarget(input: unknown): ValidationOutcome<SubagentFocusTarget> {
	if (!isRecord(input)) {
		return fail("focus target must be an object");
	}

	const agentIdError = validateRequiredText("focusTarget.agentId", input.agentId);
	if (agentIdError) return agentIdError;

	if (typeof input.availability !== "string" || !SUBAGENT_FOCUS_AVAILABILITIES.has(input.availability as SubagentFocusAvailability)) {
		return fail("focusTarget.availability must be one of: live, degraded, stopped");
	}

	if (input.tmuxMode !== "pane" && input.tmuxMode !== "window") {
		return fail("focusTarget.tmuxMode must be either \"pane\" or \"window\"");
	}

	const tmuxTargetError = validateRequiredText("focusTarget.tmuxTarget", input.tmuxTarget);
	if (tmuxTargetError) return tmuxTargetError;

	const sessionPathError = validateRequiredPath("focusTarget.sessionPath", input.sessionPath);
	if (sessionPathError) return sessionPathError;

	const focusCommandError = validateRequiredText("focusTarget.focusCommand", input.focusCommand);
	if (focusCommandError) return focusCommandError;

	if (hasOwnField(input, "note") && input.note !== undefined) {
		const noteError = validateRequiredText("focusTarget.note", input.note);
		if (noteError) return noteError;
	}

	return ok({
		agentId: (input.agentId as string).trim(),
		availability: input.availability as SubagentFocusAvailability,
		tmuxMode: input.tmuxMode,
		tmuxTarget: (input.tmuxTarget as string).trim(),
		sessionPath: input.sessionPath as string,
		focusCommand: (input.focusCommand as string).trim(),
		note: hasOwnField(input, "note") && input.note !== undefined ? (input.note as string).trim() : undefined,
	});
}

export function validateSubagentRecord<TData = unknown>(record: unknown): ValidationOutcome<SubagentRecord<TData>> {
	if (!isRecord(record)) {
		return fail("subagent record must be an object");
	}

	const idError = validateRequiredText("id", record.id);
	if (idError) return idError;

	const typeError = validateRequiredText("type", record.type);
	if (typeError) return typeError;

	const descriptionError = validateRequiredText("description", record.description);
	if (descriptionError) return descriptionError;

	const sessionError = validateRequiredPath("sessionPath", record.sessionPath);
	if (sessionError) return sessionError;

	const socketError = validateRequiredPath("socketPath", record.socketPath);
	if (socketError) return socketError;

	const state = record.state;
	if (typeof state !== "string" || !isRuntimeState(state)) {
		return fail("state must be one of: starting, connecting, ready, running, waiting, needs_input, failed, stopped");
	}
	if (!isNonEmptyTrimmedString(record.tmuxTarget)) return fail("tmuxTarget must be a non-empty string");
	if (record.tmuxMode !== "pane" && record.tmuxMode !== "window") {
		return fail("tmuxMode must be either \"pane\" or \"window\"");
	}
	if (record.childMode !== "interactive-cli") {
		return fail("childMode must be \"interactive-cli\"");
	}
	if (typeof record.createdAt !== "string" || !isIsoTimestamp(record.createdAt)) {
		return fail("createdAt must be an ISO timestamp");
	}
	if (hasOwnField(record, "startedAt") && (typeof record.startedAt !== "string" || !isIsoTimestamp(record.startedAt))) {
		return fail("startedAt must be an ISO timestamp");
	}
	if (hasOwnField(record, "stoppedAt") && (typeof record.stoppedAt !== "string" || !isIsoTimestamp(record.stoppedAt))) {
		return fail("stoppedAt must be an ISO timestamp");
	}
	if (hasOwnField(record, "connectedAt") && (typeof record.connectedAt !== "string" || !isIsoTimestamp(record.connectedAt))) {
		return fail("connectedAt must be an ISO timestamp");
	}
	if (hasOwnField(record, "degradedAt") && (typeof record.degradedAt !== "string" || !isIsoTimestamp(record.degradedAt))) {
		return fail("degradedAt must be an ISO timestamp");
	}
	if (
		hasOwnField(record, "assumptionsStaleAt")
		&& (typeof record.assumptionsStaleAt !== "string" || !isIsoTimestamp(record.assumptionsStaleAt))
	) {
		return fail("assumptionsStaleAt must be an ISO timestamp");
	}

	const userIntervenedHistory = hasOwnField(record, "userIntervenedHistory") ? record.userIntervenedHistory : undefined;
	let normalizedUserIntervenedHistory: UserIntervenedMetadata[] | undefined;
	if (hasOwnField(record, "userIntervenedHistory")) {
		if (!Array.isArray(userIntervenedHistory) || userIntervenedHistory.length === 0) {
			return fail("userIntervenedHistory must be a non-empty array");
		}
		const entries: UserIntervenedMetadata[] = [];
		for (let index = 0; index < userIntervenedHistory.length; index += 1) {
			const entryResult = validateUserIntervenedMetadata(userIntervenedHistory[index]);
			if (!entryResult.ok) {
				return fail(prefixNestedValidationError(`userIntervenedHistory[${index}]`, "userIntervened", entryResult.error));
			}
			if (entries.length > 0 && !isTimestampOnOrBefore(entries.at(-1)!.recordedAt, entryResult.value.recordedAt)) {
				return fail("userIntervenedHistory must be sorted by recordedAt");
			}
			entries.push(entryResult.value);
		}
		normalizedUserIntervenedHistory = entries;
	}
	const runtimeError = hasOwnField(record, "error") ? record.error : undefined;
	let normalizedRuntimeError: RuntimeFailure | undefined;
	if (hasOwnField(record, "error")) {
		const errorValidation = validateRuntimeFailure(runtimeError);
		if (!errorValidation.ok) return errorValidation;
		normalizedRuntimeError = errorValidation.value;
	}
	const lastProgressReport = hasOwnField(record, "lastProgressReport") ? record.lastProgressReport : undefined;
	let normalizedLastProgressReport: ExplicitReport<TData> | undefined;
	if (hasOwnField(record, "lastProgressReport")) {
		const progressReportResult = validateExplicitReport<TData>(
			"lastProgressReport",
			lastProgressReport,
			"progress",
		);
		if (!progressReportResult.ok) return progressReportResult;
		normalizedLastProgressReport = progressReportResult.value;
	}
	const pendingInputRequest = hasOwnField(record, "pendingInputRequest") ? record.pendingInputRequest : undefined;
	let normalizedPendingInputRequest: (ExplicitReport<TData> & { kind: "needs_input" }) | undefined;
	if (hasOwnField(record, "pendingInputRequest")) {
		const pendingInputResult = validateExplicitReport<TData>(
			"pendingInputRequest",
			pendingInputRequest,
			"needs_input",
		);
		if (!pendingInputResult.ok) return pendingInputResult;
		normalizedPendingInputRequest = pendingInputResult.value as ExplicitReport<TData> & { kind: "needs_input" };
	}
	const finalResult = hasOwnField(record, "finalResult") ? record.finalResult : undefined;
	let normalizedFinalResult: (ExplicitReport<TData> & { kind: "final_result" }) | undefined;
	if (hasOwnField(record, "finalResult")) {
		const finalResultValidation = validateExplicitReport<TData>("finalResult", finalResult, "final_result");
		if (!finalResultValidation.ok) return finalResultValidation;
		normalizedFinalResult = finalResultValidation.value as ExplicitReport<TData> & { kind: "final_result" };
	}
	const finalResultHistory = hasOwnField(record, "finalResultHistory") ? record.finalResultHistory : undefined;
	let normalizedFinalResultHistory: Array<ExplicitReport<TData> & { kind: "final_result" }> | undefined;
	if (hasOwnField(record, "finalResultHistory")) {
		if (!Array.isArray(finalResultHistory) || finalResultHistory.length === 0) {
			return fail("finalResultHistory must be a non-empty array");
		}
		const entries: Array<ExplicitReport<TData> & { kind: "final_result" }> = [];
		for (let index = 0; index < finalResultHistory.length; index += 1) {
			const entryResult = validateExplicitReport<TData>(
				`finalResultHistory[${index}]`,
				finalResultHistory[index],
				"final_result",
			);
			if (!entryResult.ok) return entryResult as ValidationOutcome<SubagentRecord<TData>>;
			if (entries.length > 0 && !isTimestampOnOrBefore(entries.at(-1)!.reportedAt, entryResult.value.reportedAt)) {
				return fail("finalResultHistory must be sorted by reportedAt");
			}
			entries.push(entryResult.value as ExplicitReport<TData> & { kind: "final_result" });
		}
		normalizedFinalResultHistory = entries;
	}
	if (hasOwnField(record, "stoppedAt") && state !== "stopped") {
		return fail("stoppedAt may only be present when state is stopped");
	}
	if (STATES_REQUIRING_CONNECTED_AT.has(state) && !hasOwnField(record, "connectedAt")) {
		return fail(`${state} records must include connectedAt`);
	}
	if (state === "needs_input" && !normalizedPendingInputRequest) {
		return fail("needs_input records must include pendingInputRequest");
	}
	if (state === "failed" && !normalizedRuntimeError) {
		return fail("failed records must include error");
	}
	if (state === "stopped" && !hasOwnField(record, "stoppedAt")) {
		return fail("stopped records must include stoppedAt");
	}
	if (normalizedRuntimeError && state !== "failed") {
		return fail("error may only be present when state is failed");
	}
	if (normalizedPendingInputRequest && state !== "needs_input") {
		return fail("pendingInputRequest may only be present when state is needs_input");
	}
	if (normalizedFinalResult && !normalizedFinalResultHistory) {
		return fail("finalResult requires finalResultHistory");
	}
	if (normalizedFinalResultHistory && !normalizedFinalResult) {
		return fail("finalResultHistory requires finalResult");
	}

	const startedAt = record.startedAt as string | undefined;
	const stoppedAt = record.stoppedAt as string | undefined;
	const connectedAt = record.connectedAt as string | undefined;
	const degradedAt = record.degradedAt as string | undefined;
	const assumptionsStaleAt = record.assumptionsStaleAt as string | undefined;

	if (
		(
			normalizedLastProgressReport
			|| normalizedPendingInputRequest
			|| normalizedUserIntervenedHistory
			|| normalizedFinalResult
			|| normalizedFinalResultHistory
			|| degradedAt
			|| assumptionsStaleAt
		)
		&& !connectedAt
	) {
		return fail("sidecar-derived fields require connectedAt");
	}
	if (PRE_HANDSHAKE_STATES.has(state) && connectedAt) {
		return fail(`${state} records may not include connectedAt`);
	}
	if (
		PRE_HANDSHAKE_STATES.has(state)
		&& (
			normalizedLastProgressReport
			|| normalizedPendingInputRequest
			|| normalizedUserIntervenedHistory
			|| normalizedFinalResult
			|| normalizedFinalResultHistory
			|| degradedAt
			|| assumptionsStaleAt
		)
	) {
		return fail(`${state} records may not include post-handshake sidecar fields`);
	}

	if (startedAt && !isTimestampOnOrBefore(record.createdAt as string, startedAt)) {
		return fail("startedAt must be on or after createdAt");
	}
	if (connectedAt) {
		const connectionBaseline = startedAt ?? (record.createdAt as string);
		const connectionBaselineLabel = startedAt ? "startedAt" : "createdAt";
		if (!isTimestampOnOrBefore(connectionBaseline, connectedAt)) {
			return fail(`connectedAt must be on or after ${connectionBaselineLabel}`);
		}
	}
	if (stoppedAt) {
		const stoppedBaseline = connectedAt ?? startedAt ?? (record.createdAt as string);
		const stoppedBaselineLabel = connectedAt ? "connectedAt" : startedAt ? "startedAt" : "createdAt";
		if (!isTimestampOnOrBefore(stoppedBaseline, stoppedAt)) {
			return fail(`stoppedAt must be on or after ${stoppedBaselineLabel}`);
		}
	}
	if (degradedAt) {
		const degradedBaseline = connectedAt ?? startedAt ?? (record.createdAt as string);
		const degradedBaselineLabel = connectedAt ? "connectedAt" : startedAt ? "startedAt" : "createdAt";
		if (!isTimestampOnOrBefore(degradedBaseline, degradedAt)) {
			return fail(`degradedAt must be on or after ${degradedBaselineLabel}`);
		}
	}
	if (assumptionsStaleAt) {
		const assumptionsStaleBaseline = connectedAt ?? startedAt ?? (record.createdAt as string);
		const assumptionsStaleBaselineLabel = connectedAt ? "connectedAt" : startedAt ? "startedAt" : "createdAt";
		if (!isTimestampOnOrBefore(assumptionsStaleBaseline, assumptionsStaleAt)) {
			return fail(`assumptionsStaleAt must be on or after ${assumptionsStaleBaselineLabel}`);
		}
	}
	if (stoppedAt && degradedAt && !isTimestampOnOrBefore(degradedAt, stoppedAt)) {
		return fail("degradedAt must be on or before stoppedAt");
	}
	if (stoppedAt && assumptionsStaleAt && !isTimestampOnOrBefore(assumptionsStaleAt, stoppedAt)) {
		return fail("assumptionsStaleAt must be on or before stoppedAt");
	}
	if (degradedAt && assumptionsStaleAt && !isTimestampOnOrBefore(assumptionsStaleAt, degradedAt)) {
		return fail("assumptionsStaleAt must be on or before degradedAt");
	}

	if (state === "stopped" && stoppedAt) {
		if (
			normalizedLastProgressReport &&
			!isTimestampOnOrBefore(normalizedLastProgressReport.reportedAt, stoppedAt)
		) {
			return fail("lastProgressReport.reportedAt must be on or before terminal stop");
		}
		if (
			normalizedPendingInputRequest &&
			!isTimestampOnOrBefore(normalizedPendingInputRequest.reportedAt, stoppedAt)
		) {
			return fail("pendingInputRequest.reportedAt must be on or before terminal stop");
		}
		if (
			normalizedUserIntervenedHistory
			&& normalizedUserIntervenedHistory.some((entry) => !isTimestampOnOrBefore(entry.recordedAt, stoppedAt))
		) {
			return fail("userIntervenedHistory entries must be on or before terminal stop");
		}
		if (
			normalizedFinalResultHistory
			&& normalizedFinalResultHistory.some((entry) => !isTimestampOnOrBefore(entry.reportedAt, stoppedAt))
		) {
			return fail("finalResultHistory entries must be on or before terminal stop");
		}
	}
	if (degradedAt) {
		if (
			normalizedLastProgressReport &&
			!isTimestampOnOrBefore(normalizedLastProgressReport.reportedAt, degradedAt)
		) {
			return fail("lastProgressReport.reportedAt must be on or before degradedAt");
		}
		if (
			normalizedPendingInputRequest &&
			!isTimestampOnOrBefore(normalizedPendingInputRequest.reportedAt, degradedAt)
		) {
			return fail("pendingInputRequest.reportedAt must be on or before degradedAt");
		}
		if (
			normalizedUserIntervenedHistory
			&& normalizedUserIntervenedHistory.some((entry) => !isTimestampOnOrBefore(entry.recordedAt, degradedAt))
		) {
			return fail("userIntervenedHistory entries must be on or before degradedAt");
		}
		if (
			normalizedFinalResultHistory
			&& normalizedFinalResultHistory.some((entry) => !isTimestampOnOrBefore(entry.reportedAt, degradedAt))
		) {
			return fail("finalResultHistory entries must be on or before degradedAt");
		}
	}
	if (assumptionsStaleAt) {
		if (!normalizedUserIntervenedHistory) {
			return fail("assumptionsStaleAt requires userIntervenedHistory");
		}
		const latestIntervention = normalizedUserIntervenedHistory.at(-1);
		if (!latestIntervention || latestIntervention.recordedAt !== assumptionsStaleAt) {
			return fail("assumptionsStaleAt must match the latest userIntervenedHistory entry");
		}
		if (
			normalizedLastProgressReport
			&& !isTimestampOnOrBefore(normalizedLastProgressReport.reportedAt, assumptionsStaleAt)
		) {
			return fail("lastProgressReport.reportedAt must be on or before assumptionsStaleAt");
		}
		if (
			normalizedPendingInputRequest
			&& !isTimestampOnOrBefore(normalizedPendingInputRequest.reportedAt, assumptionsStaleAt)
		) {
			return fail("pendingInputRequest.reportedAt must be on or before assumptionsStaleAt");
		}
		if (
			normalizedFinalResultHistory
			&& normalizedFinalResultHistory.some((entry) => !isTimestampOnOrBefore(entry.reportedAt, assumptionsStaleAt))
		) {
			return fail("finalResultHistory entries must be on or before assumptionsStaleAt");
		}
		if (
			normalizedUserIntervenedHistory
			&& normalizedUserIntervenedHistory.some((entry) => !isTimestampOnOrBefore(entry.recordedAt, assumptionsStaleAt))
		) {
			return fail("userIntervenedHistory entries must be on or before assumptionsStaleAt");
		}
	}
	if (normalizedLastProgressReport) {
		if (!isTimestampOnOrBefore(record.createdAt as string, normalizedLastProgressReport.reportedAt)) {
			return fail("lastProgressReport.reportedAt must be on or after createdAt");
		}
		if (connectedAt && !isTimestampOnOrBefore(connectedAt, normalizedLastProgressReport.reportedAt)) {
			return fail("lastProgressReport.reportedAt must be on or after connectedAt");
		}
	}
	if (normalizedPendingInputRequest) {
		if (!isTimestampOnOrBefore(record.createdAt as string, normalizedPendingInputRequest.reportedAt)) {
			return fail("pendingInputRequest.reportedAt must be on or after createdAt");
		}
		if (connectedAt && !isTimestampOnOrBefore(connectedAt, normalizedPendingInputRequest.reportedAt)) {
			return fail("pendingInputRequest.reportedAt must be on or after connectedAt");
		}
	}
	if (normalizedFinalResult) {
		if (!isTimestampOnOrBefore(record.createdAt as string, normalizedFinalResult.reportedAt)) {
			return fail("finalResult.reportedAt must be on or after createdAt");
		}
		if (connectedAt && !isTimestampOnOrBefore(connectedAt, normalizedFinalResult.reportedAt)) {
			return fail("finalResult.reportedAt must be on or after connectedAt");
		}
	}
	if (normalizedFinalResultHistory) {
		for (const entry of normalizedFinalResultHistory) {
			if (!isTimestampOnOrBefore(record.createdAt as string, entry.reportedAt)) {
				return fail("finalResultHistory entries must be on or after createdAt");
			}
			if (connectedAt && !isTimestampOnOrBefore(connectedAt, entry.reportedAt)) {
				return fail("finalResultHistory entries must be on or after connectedAt");
			}
		}
	}
	if (normalizedUserIntervenedHistory) {
		for (const entry of normalizedUserIntervenedHistory) {
			if (!isTimestampOnOrBefore(record.createdAt as string, entry.recordedAt)) {
				return fail("userIntervenedHistory entries must be on or after createdAt");
			}
			if (connectedAt && !isTimestampOnOrBefore(connectedAt, entry.recordedAt)) {
				return fail("userIntervenedHistory entries must be on or after connectedAt");
			}
		}
	}
	if (normalizedRuntimeError) {
		if (!isTimestampOnOrBefore(record.createdAt as string, normalizedRuntimeError.recordedAt)) {
			return fail("error.recordedAt must be on or after createdAt");
		}
		if (startedAt && !isTimestampOnOrBefore(startedAt, normalizedRuntimeError.recordedAt)) {
			return fail("error.recordedAt must be on or after startedAt");
		}
		if (connectedAt && !isTimestampOnOrBefore(connectedAt, normalizedRuntimeError.recordedAt)) {
			return fail("error.recordedAt must be on or after connectedAt");
		}
	}
	if (normalizedFinalResult && normalizedFinalResultHistory) {
		const latestHistoryEntry = normalizedFinalResultHistory.at(-1)!;
		const dataEqualityResult = safeDeepStrictEqual(
			"finalResult.data",
			latestHistoryEntry.data ?? null,
			normalizedFinalResult.data ?? null,
		);
		if (!dataEqualityResult.ok) return dataEqualityResult;
		if (
			latestHistoryEntry.summary !== normalizedFinalResult.summary
			|| latestHistoryEntry.reportedAt !== normalizedFinalResult.reportedAt
			|| !dataEqualityResult.value
		) {
			return fail("finalResult must match the latest finalResultHistory entry");
		}
	}

	const normalizedRecord: SubagentRecord<TData> = {
		id: record.id as string,
		type: record.type as string,
		description: record.description as string,
		state,
		tmuxMode: record.tmuxMode,
		tmuxTarget: record.tmuxTarget as string,
		sessionPath: record.sessionPath as string,
		socketPath: record.socketPath as string,
		childMode: record.childMode,
		createdAt: record.createdAt as string,
		startedAt,
		stoppedAt,
		connectedAt,
		degradedAt,
		assumptionsStaleAt,
		userIntervenedHistory: normalizedUserIntervenedHistory,
		lastProgressReport: normalizedLastProgressReport,
		pendingInputRequest: normalizedPendingInputRequest,
		finalResult: normalizedFinalResult,
		finalResultHistory: normalizedFinalResultHistory,
		error: normalizedRuntimeError,
	};

	return ok(normalizedRecord);
}
