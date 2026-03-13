import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	createRuntimeLaunchSpec,
	validateRuntimeBootstrapConfig,
	type RuntimeBootstrapConfig,
	type RuntimeChildMode,
	type RuntimeLaunchSpec,
	type TmuxMode,
	type ValidationError,
	type ValidationOutcome,
	type ValidationResult,
} from "./contracts.js";
import type { ManagedSubagentSpawnRequest } from "./subagent-manager.js";

export type AgentDefinitionSource = "default" | "global" | "project";
export type AgentDefinitionPromptMode = "replace" | "append";

export interface AgentDefinition {
	name: string;
	displayName?: string;
	description: string;
	instructions: string;
	promptMode: AgentDefinitionPromptMode;
	enabled: boolean;
	source: AgentDefinitionSource;
	isDefault: boolean;
	definitionPath?: string;
}

export interface ResolvedAgentDefinition extends AgentDefinition {
	requestedName: string;
}

export interface EmbeddedAgentDefinitionInput {
	name: string;
	displayName?: string;
	description: string;
	instructions: string;
	promptMode?: AgentDefinitionPromptMode;
	enabled?: boolean;
}

export interface AgentDefinitionRegistryOptions {
	cwd: string;
	homeDir?: string;
	projectDefinitionsDir?: string;
	globalDefinitionsDir?: string;
	defaultDefinitions?: ReadonlyArray<EmbeddedAgentDefinitionInput>;
}

export interface PrepareNamedSubagentSpawnInput {
	registry: AgentDefinitionRegistry;
	type: string;
	description: string;
	taskPrompt: string;
	agentId: string;
	sessionPath: string;
	socketPath: string;
	tmuxMode: TmuxMode;
	tmuxTarget: string;
	bootstrapConfigPath: string;
	bootstrapExtensionPath: string;
	cwd: string;
	childMode?: RuntimeChildMode;
	writeBootstrapConfig?: (bootstrapConfigPath: string, serializedConfig: string) => void;
}

export interface PreparedNamedSubagentSpawn {
	definition: ResolvedAgentDefinition;
	initialPrompt: string;
	bootstrapConfig: RuntimeBootstrapConfig;
	launchSpec: RuntimeLaunchSpec;
	request: ManagedSubagentSpawnRequest;
}

export const SUPPORTED_AGENT_DEFINITION_FRONTMATTER_FIELDS = new Set([
	"description",
	"display_name",
	"enabled",
	"prompt_mode",
]);

const PROJECT_DEFINITIONS_RELATIVE_DIR = path.join(".pi", "agents");
const GLOBAL_DEFINITIONS_RELATIVE_DIR = path.join(".pi", "agent", "agents");
const GENERAL_PURPOSE_INSTRUCTIONS = `# Role
You are a general-purpose coding agent for complex, multi-step tasks.
You have full access to read, write, edit files, and execute commands.
Do what has been asked; nothing more, nothing less.

# Tool Usage
- Use the read tool instead of cat/head/tail
- Use the edit tool instead of sed/awk
- Use the write tool instead of echo/heredoc
- Use the find tool instead of bash find/ls for file search
- Use the grep tool instead of bash grep/rg for content search
- Make independent tool calls in parallel

# File Operations
- NEVER create files unless absolutely necessary
- Prefer editing existing files over creating new ones
- NEVER create documentation files unless explicitly requested

# Git Safety
- NEVER update git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) without explicit request
- NEVER skip hooks (--no-verify, --no-gpg-sign) unless explicitly asked
- NEVER force push to main/master - warn the user if they request it
- Always create NEW commits, never amend existing ones. When a pre-commit hook fails, the commit did NOT happen - so --amend would modify the PREVIOUS commit. Fix the issue, re-stage, and create a NEW commit
- Stage specific files by name, not git add -A or git add .
- NEVER commit changes unless the user explicitly asks
- NEVER push unless the user explicitly asks
- NEVER use git commands with the -i flag (like git rebase -i or git add -i) - they require interactive input
- Do not use --no-edit with git rebase commands
- Do not commit files that likely contain secrets (.env, credentials.json, etc); warn the user if they request it

# Output
- Use absolute file paths
- Do not use emojis
- Be concise but complete`;
const EXPLORE_INSTRUCTIONS = `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a file search specialist. You excel at thoroughly navigating and exploring codebases.
Your role is EXCLUSIVELY to search and analyze existing code.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

# Tool Usage
- Use read-only operations when exploring
- Adapt your search approach based on the level of thoroughness the task requires

# Output
- Use absolute file paths in all references
- Be thorough and precise`;
const PLAN_INSTRUCTIONS = `# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
You are a software architect and planning specialist.
Your role is EXCLUSIVELY to explore the codebase and design implementation plans.

You are STRICTLY PROHIBITED from:
- Creating new files
- Modifying existing files
- Deleting files
- Moving or copying files
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

# Planning Process
1. Understand requirements
2. Explore thoroughly and identify the real implementation owners
3. Design the smallest solution that satisfies the task
4. Detail the plan with sequencing, tradeoffs, and risks

# Output
- Use absolute file paths
- Be concise but complete`;

export const DEFAULT_AGENT_DEFINITIONS: ReadonlyArray<EmbeddedAgentDefinitionInput> = [
	{
		name: "general-purpose",
		displayName: "Agent",
		description: "General-purpose agent for complex, multi-step tasks",
		instructions: GENERAL_PURPOSE_INSTRUCTIONS,
	},
	{
		name: "Explore",
		displayName: "Explore",
		description: "Fast codebase exploration agent (read-only)",
		instructions: EXPLORE_INSTRUCTIONS,
	},
	{
		name: "Plan",
		displayName: "Plan",
		description: "Software architect for implementation planning (read-only)",
		instructions: PLAN_INSTRUCTIONS,
	},
];

function fail(error: string): ValidationError {
	return { ok: false, error };
}

function ok<T>(value: T): ValidationResult<T> {
	return { ok: true, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefinition(definition: AgentDefinition): AgentDefinition {
	return { ...definition };
}

function cloneResolvedDefinition(definition: ResolvedAgentDefinition): ResolvedAgentDefinition {
	return { ...definition };
}

function normalizeTextField(field: string, value: unknown): ValidationOutcome<string> {
	if (typeof value !== "string") {
		return fail(`${field} must be a string`);
	}

	const normalized = value.trim();
	if (normalized.length === 0) {
		return fail(`${field} must be a non-empty string`);
	}

	return ok(normalized);
}

function normalizeOptionalTextField(field: string, value: unknown): ValidationOutcome<string | undefined> {
	if (value === undefined) {
		return ok(undefined);
	}

	const normalizedResult = normalizeTextField(field, value);
	if (!normalizedResult.ok) return normalizedResult;
	return ok(normalizedResult.value);
}

function toCanonicalLookupKey(name: string): string {
	return name.trim().toLowerCase();
}

function normalizePromptMode(value: unknown): ValidationOutcome<AgentDefinitionPromptMode> {
	if (value === undefined) return ok("replace");
	if (value === "replace" || value === "append") {
		return ok(value);
	}

	return fail('prompt_mode must be either "replace" or "append"');
}

function normalizeEnabled(value: unknown): ValidationOutcome<boolean> {
	if (value === undefined) return ok(true);
	if (typeof value === "boolean") return ok(value);
	return fail("enabled must be a boolean");
}

function parseFrontmatterScalar(rawValue: string): string | boolean {
	const trimmed = rawValue.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
		|| (trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}

	return trimmed;
}

function splitFrontmatterDocument(documentText: string): ValidationOutcome<{
	frontmatter: Record<string, unknown>;
	body: string;
}> {
	const normalizedText = documentText.replace(/\r\n/g, "\n");
	const lines = normalizedText.split("\n");
	if (lines[0]?.trim() !== "---") {
		return ok({
			frontmatter: {},
			body: normalizedText,
		});
	}

	let closingIndex = -1;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index]?.trim() === "---") {
			closingIndex = index;
			break;
		}
	}
	if (closingIndex < 0) {
		return fail("agent definition frontmatter must end with ---");
	}

	const frontmatter: Record<string, unknown> = {};
	for (const line of lines.slice(1, closingIndex)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			continue;
		}

		const separatorIndex = trimmed.indexOf(":");
		if (separatorIndex <= 0) {
			return fail(`invalid agent definition frontmatter line: ${trimmed}`);
		}

		const key = trimmed.slice(0, separatorIndex).trim();
		if (!SUPPORTED_AGENT_DEFINITION_FRONTMATTER_FIELDS.has(key)) {
			return fail(`unsupported agent definition field: ${key}`);
		}
		if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
			return fail(`duplicate agent definition field: ${key}`);
		}

		const rawValue = trimmed.slice(separatorIndex + 1);
		frontmatter[key] = parseFrontmatterScalar(rawValue);
	}

	return ok({
		frontmatter,
		body: lines.slice(closingIndex + 1).join("\n"),
	});
}

function normalizeAgentDefinition(input: {
	name: unknown;
	displayName?: unknown;
	description?: unknown;
	instructions?: unknown;
	promptMode?: unknown;
	enabled?: unknown;
	source: AgentDefinitionSource;
	definitionPath?: string;
}): ValidationOutcome<AgentDefinition> {
	const nameResult = normalizeTextField("name", input.name);
	if (!nameResult.ok) return nameResult;

	const displayNameResult = normalizeOptionalTextField("displayName", input.displayName);
	if (!displayNameResult.ok) return displayNameResult;

	const promptModeResult = normalizePromptMode(input.promptMode);
	if (!promptModeResult.ok) return promptModeResult;

	const enabledResult = normalizeEnabled(input.enabled);
	if (!enabledResult.ok) return enabledResult;

	const descriptionValue = input.description ?? nameResult.value;
	const descriptionResult = normalizeTextField("description", descriptionValue);
	if (!descriptionResult.ok) return descriptionResult;

	const rawInstructions = typeof input.instructions === "string" ? input.instructions.trim() : "";
	if (enabledResult.value && rawInstructions.length === 0) {
		return fail("instructions must be a non-empty string");
	}

	return ok({
		name: nameResult.value,
		displayName: displayNameResult.value,
		description: descriptionResult.value,
		instructions: rawInstructions,
		promptMode: promptModeResult.value,
		enabled: enabledResult.value,
		source: input.source,
		isDefault: input.source === "default",
		definitionPath: input.definitionPath,
	});
}

function normalizeEmbeddedDefinitionInput(input: EmbeddedAgentDefinitionInput): ValidationOutcome<AgentDefinition> {
	return normalizeAgentDefinition({
		name: input.name,
		displayName: input.displayName,
		description: input.description,
		instructions: input.instructions,
		promptMode: input.promptMode,
		enabled: input.enabled,
		source: "default",
	});
}

function normalizeCustomDefinitionDocument(
	fileName: string,
	filePath: string,
	documentText: string,
	source: Exclude<AgentDefinitionSource, "default">,
): ValidationOutcome<AgentDefinition> {
	const splitResult = splitFrontmatterDocument(documentText);
	if (!splitResult.ok) return splitResult;

	const name = path.basename(fileName, ".md");
	const frontmatter = splitResult.value.frontmatter;
	return normalizeAgentDefinition({
		name,
		displayName: frontmatter.display_name,
		description: frontmatter.description,
		instructions: splitResult.value.body,
		promptMode: frontmatter.prompt_mode,
		enabled: frontmatter.enabled,
		source,
		definitionPath: filePath,
	});
}

function loadDefinitionsFromDir(
	dirPath: string,
	source: Exclude<AgentDefinitionSource, "default">,
): ValidationOutcome<Map<string, AgentDefinition>> {
	if (!fs.existsSync(dirPath)) {
		return ok(new Map());
	}

	let stats: fs.Stats;
	try {
		stats = fs.statSync(dirPath);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return fail(`failed to inspect ${source} agent definition directory: ${reason}`);
	}
	if (!stats.isDirectory()) {
		return fail(`${source} agent definition path must be a directory`);
	}

	let entries: string[];
	try {
		entries = fs.readdirSync(dirPath).sort((left, right) => left.localeCompare(right));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return fail(`failed to read ${source} agent definition directory: ${reason}`);
	}

	const definitions = new Map<string, AgentDefinition>();
	for (const entry of entries) {
		if (!entry.endsWith(".md")) {
			continue;
		}

		const definitionPath = path.join(dirPath, entry);
		let documentText: string;
		try {
			documentText = fs.readFileSync(definitionPath, "utf8");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return fail(`failed to read agent definition ${definitionPath}: ${reason}`);
		}

		const definitionResult = normalizeCustomDefinitionDocument(entry, definitionPath, documentText, source);
		if (!definitionResult.ok) return definitionResult;

		const canonicalKey = toCanonicalLookupKey(definitionResult.value.name);
		if (definitions.has(canonicalKey)) {
			return fail(`${source} agent definitions contain a duplicate canonical name: ${definitionResult.value.name}`);
		}

		definitions.set(canonicalKey, definitionResult.value);
	}

	return ok(definitions);
}

function loadDefaultDefinitions(
	defaultDefinitions: ReadonlyArray<EmbeddedAgentDefinitionInput>,
): ValidationOutcome<Map<string, AgentDefinition>> {
	const definitions = new Map<string, AgentDefinition>();
	for (const rawDefinition of defaultDefinitions) {
		const definitionResult = normalizeEmbeddedDefinitionInput(rawDefinition);
		if (!definitionResult.ok) return definitionResult;

		const canonicalKey = toCanonicalLookupKey(definitionResult.value.name);
		if (definitions.has(canonicalKey)) {
			return fail(`default agent definitions contain a duplicate canonical name: ${definitionResult.value.name}`);
		}

		definitions.set(canonicalKey, definitionResult.value);
	}

	return ok(definitions);
}

function buildRegistryDefinitions(
	options: AgentDefinitionRegistryOptions,
): ValidationOutcome<Map<string, AgentDefinition>> {
	const defaultDefinitionsResult = loadDefaultDefinitions(options.defaultDefinitions ?? DEFAULT_AGENT_DEFINITIONS);
	if (!defaultDefinitionsResult.ok) return defaultDefinitionsResult;

	const homeDir = options.homeDir ?? os.homedir();
	const globalDefinitionsDir = options.globalDefinitionsDir ?? path.join(homeDir, GLOBAL_DEFINITIONS_RELATIVE_DIR);
	const projectDefinitionsDir = options.projectDefinitionsDir ?? path.join(options.cwd, PROJECT_DEFINITIONS_RELATIVE_DIR);

	const globalDefinitionsResult = loadDefinitionsFromDir(globalDefinitionsDir, "global");
	if (!globalDefinitionsResult.ok) return globalDefinitionsResult;

	const projectDefinitionsResult = loadDefinitionsFromDir(projectDefinitionsDir, "project");
	if (!projectDefinitionsResult.ok) return projectDefinitionsResult;

	const mergedDefinitions = new Map(defaultDefinitionsResult.value);
	for (const [canonicalKey, definition] of globalDefinitionsResult.value) {
		mergedDefinitions.set(canonicalKey, definition);
	}
	for (const [canonicalKey, definition] of projectDefinitionsResult.value) {
		mergedDefinitions.set(canonicalKey, definition);
	}

	return ok(mergedDefinitions);
}

export class AgentDefinitionRegistry {
	private definitions = new Map<string, AgentDefinition>();

	private loaded = false;

	public constructor(private readonly options: AgentDefinitionRegistryOptions) {}

	public refresh(): ValidationOutcome<AgentDefinitionRegistry> {
		const definitionsResult = buildRegistryDefinitions(this.options);
		if (!definitionsResult.ok) return definitionsResult;

		this.definitions = definitionsResult.value;
		this.loaded = true;
		return ok(this);
	}

	public listDefinitions(): ReadonlyArray<AgentDefinition> {
		return Array.from(this.definitions.values())
			.map(cloneDefinition)
			.sort((left, right) => left.name.localeCompare(right.name));
	}

	public listAvailableDefinitions(): ReadonlyArray<AgentDefinition> {
		return this.listDefinitions().filter((definition) => definition.enabled);
	}

	public resolve(name: string): ValidationOutcome<ResolvedAgentDefinition> {
		const nameResult = normalizeTextField("type", name);
		if (!nameResult.ok) return nameResult;
		if (!this.loaded) {
			return fail("agent definition registry has not been loaded");
		}

		const definition = this.definitions.get(toCanonicalLookupKey(nameResult.value));
		if (!definition) {
			return fail(`unknown agent type: ${nameResult.value}`);
		}
		if (!definition.enabled) {
			return fail(`agent type is disabled: ${definition.name}`);
		}

		return ok({
			...cloneDefinition(definition),
			requestedName: nameResult.value,
		});
	}
}

export function loadAgentDefinitionRegistry(
	options: AgentDefinitionRegistryOptions,
): ValidationOutcome<AgentDefinitionRegistry> {
	const registry = new AgentDefinitionRegistry(options);
	const refreshResult = registry.refresh();
	if (!refreshResult.ok) return refreshResult;
	return ok(registry);
}

export function composeNamedSubagentInitialPrompt(
	definition: AgentDefinition,
	taskPrompt: string,
): ValidationOutcome<string> {
	const taskPromptResult = normalizeTextField("taskPrompt", taskPrompt);
	if (!taskPromptResult.ok) return taskPromptResult;

	const instructions = definition.promptMode === "append"
		? `${GENERAL_PURPOSE_INSTRUCTIONS}\n\n${definition.instructions}`.trim()
		: definition.instructions;

	return ok([
		`Agent type: ${definition.name}`,
		`Description: ${definition.description}`,
		"",
		instructions,
		"",
		"Task:",
		taskPromptResult.value,
	].join("\n"));
}

export function prepareNamedSubagentSpawn(
	input: PrepareNamedSubagentSpawnInput,
): ValidationOutcome<PreparedNamedSubagentSpawn> {
	if (!isRecord(input)) {
		return fail("named subagent spawn input must be an object");
	}

	const descriptionResult = normalizeTextField("description", input.description);
	if (!descriptionResult.ok) return descriptionResult;

	const resolvedDefinitionResult = input.registry.resolve(input.type);
	if (!resolvedDefinitionResult.ok) return resolvedDefinitionResult;

	const initialPromptResult = composeNamedSubagentInitialPrompt(resolvedDefinitionResult.value, input.taskPrompt);
	if (!initialPromptResult.ok) return initialPromptResult;

	const bootstrapConfigPathResult = normalizeTextField("bootstrapConfigPath", input.bootstrapConfigPath);
	if (!bootstrapConfigPathResult.ok) return bootstrapConfigPathResult;
	if (!path.isAbsolute(bootstrapConfigPathResult.value)) {
		return fail("bootstrapConfigPath must be an absolute path");
	}
	if (fs.existsSync(bootstrapConfigPathResult.value)) {
		return fail("bootstrapConfigPath must not already exist");
	}

	const bootstrapConfig: RuntimeBootstrapConfig = {
		agentId: input.agentId,
		sessionPath: input.sessionPath,
		socketPath: input.socketPath,
		tmuxMode: input.tmuxMode,
		tmuxTarget: input.tmuxTarget,
		initialPrompt: initialPromptResult.value,
		bootstrapExtensionPath: input.bootstrapExtensionPath,
		cwd: input.cwd,
		childMode: input.childMode ?? "interactive-cli",
	};
	const bootstrapValidation = validateRuntimeBootstrapConfig(bootstrapConfig);
	if (!bootstrapValidation.ok) return bootstrapValidation;

	const writer = input.writeBootstrapConfig ?? ((bootstrapConfigPath: string, serializedConfig: string) => {
		fs.writeFileSync(bootstrapConfigPath, serializedConfig, "utf8");
	});
	try {
		writer(
			bootstrapConfigPathResult.value,
			`${JSON.stringify(bootstrapValidation.value, null, 2)}\n`,
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return fail(`failed to write bootstrap config: ${reason}`);
	}

	const launchSpecResult = createRuntimeLaunchSpec(bootstrapValidation.value, bootstrapConfigPathResult.value);
	if (!launchSpecResult.ok) {
		try {
			fs.rmSync(bootstrapConfigPathResult.value, { force: true });
		} catch {
			// Best-effort cleanup after launch-spec preparation failure.
		}
		return launchSpecResult;
	}

	return ok({
		definition: cloneResolvedDefinition(resolvedDefinitionResult.value),
		initialPrompt: initialPromptResult.value,
		bootstrapConfig: bootstrapValidation.value,
		launchSpec: launchSpecResult.value,
		request: {
			type: resolvedDefinitionResult.value.name,
			description: descriptionResult.value,
			launchSpec: launchSpecResult.value,
		},
	});
}
