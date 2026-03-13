import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
	AgentDefinitionRegistry,
	composeNamedSubagentInitialPrompt,
	loadAgentDefinitionRegistry,
	prepareNamedSubagentSpawn,
} from "../src/agent-definitions.js";

let originalPath: string | undefined;
let originalHome: string | undefined;
let fakeBinDir = os.tmpdir();
let fakeHomeDir = os.tmpdir();
let fakeRepoDir = os.tmpdir();
let fakeBootstrapExtensionPath = path.join(os.tmpdir(), "subagent-bootstrap.ts");

function writeProjectAgent(name: string, content: string): string {
	const definitionsDir = path.join(fakeRepoDir, ".pi", "agents");
	fs.mkdirSync(definitionsDir, { recursive: true });
	const definitionPath = path.join(definitionsDir, `${name}.md`);
	fs.writeFileSync(definitionPath, content, "utf8");
	return definitionPath;
}

function writeGlobalAgent(name: string, content: string): string {
	const definitionsDir = path.join(fakeHomeDir, ".pi", "agent", "agents");
	fs.mkdirSync(definitionsDir, { recursive: true });
	const definitionPath = path.join(definitionsDir, `${name}.md`);
	fs.writeFileSync(definitionPath, content, "utf8");
	return definitionPath;
}

function makeRegistry(): AgentDefinitionRegistry {
	return new AgentDefinitionRegistry({
		cwd: fakeRepoDir,
		homeDir: fakeHomeDir,
	});
}

beforeAll(() => {
	originalPath = process.env.PATH;
	originalHome = process.env.HOME;
	fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-agent-defs-bin-"));
	fakeHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-agent-defs-home-"));
	fakeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-nexus-agent-defs-repo-"));
	fakeBootstrapExtensionPath = path.join(fakeRepoDir, "subagent-bootstrap.ts");

	fs.writeFileSync(path.join(fakeBinDir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	fs.writeFileSync(fakeBootstrapExtensionPath, "export {};\n");

	process.env.PATH = [fakeBinDir, originalPath].filter((value): value is string => typeof value === "string").join(path.delimiter);
	process.env.HOME = fakeHomeDir;
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

	fs.rmSync(fakeBinDir, { recursive: true, force: true });
	fs.rmSync(fakeHomeDir, { recursive: true, force: true });
	fs.rmSync(fakeRepoDir, { recursive: true, force: true });
});

beforeEach(() => {
	fs.rmSync(path.join(fakeRepoDir, ".pi"), { recursive: true, force: true });
	fs.rmSync(path.join(fakeHomeDir, ".pi"), { recursive: true, force: true });
});

describe("loadAgentDefinitionRegistry", () => {
	it("returns a validation error for malformed registry options instead of throwing", () => {
		expect(loadAgentDefinitionRegistry(null as unknown as AgentDefinitionRegistry["options"])).toEqual({
			ok: false,
			error: "agent definition registry options must be an object",
		});
		expect(loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
			defaultDefinitions: "bad" as unknown as [],
		})).toEqual({
			ok: false,
			error: "defaultDefinitions must be an array",
		});
		expect(loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
			defaultDefinitions: [null as unknown as never],
		})).toEqual({
			ok: false,
			error: "embedded agent definition must be an object",
		});
	});

	it("loads the embedded defaults into a strict runtime registry", () => {
		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) {
			return;
		}

		expect(registryResult.value.listAvailableDefinitions().map((definition) => definition.name)).toEqual([
			"Explore",
			"general-purpose",
			"Plan",
		]);

		const resolvedResult = registryResult.value.resolve("EXPLORE");
		expect(resolvedResult.ok).toBe(true);
		if (!resolvedResult.ok) {
			return;
		}

		expect(resolvedResult.value.name).toBe("Explore");
		expect(resolvedResult.value.requestedName).toBe("EXPLORE");
		expect(resolvedResult.value.source).toBe("default");
	});

	it("applies deterministic precedence as project over global over default", () => {
		writeGlobalAgent(
			"Explore",
			`---
description: Global Explore
---

Global explore instructions.`,
		);
		const projectDefinitionPath = writeProjectAgent(
			"explore",
			`---
description: Project Explore
display_name: Project Explorer
---

Project explore instructions.`,
		);

		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) {
			return;
		}

		const resolvedResult = registryResult.value.resolve("Explore");
		expect(resolvedResult.ok).toBe(true);
		if (!resolvedResult.ok) {
			return;
		}

		expect(resolvedResult.value.name).toBe("explore");
		expect(resolvedResult.value.displayName).toBe("Project Explorer");
		expect(resolvedResult.value.description).toBe("Project Explore");
		expect(resolvedResult.value.instructions).toContain("Project explore instructions.");
		expect(resolvedResult.value.source).toBe("project");
		expect(resolvedResult.value.definitionPath).toBe(projectDefinitionPath);
	});

	it("rejects unsupported legacy fields", () => {
		writeProjectAgent(
			"auditor",
			`---
description: Auditor
tools: read, grep
---

Audit the repository.`,
		);

		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult).toEqual({
			ok: false,
			error: "unsupported agent definition field: tools",
		});
	});

	it("allows a disabled override with no body and hard-fails resolution", () => {
		writeProjectAgent(
			"Plan",
			`---
description: Disabled Plan
enabled: false
---
`,
		);

		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) {
			return;
		}

		expect(registryResult.value.listAvailableDefinitions().map((definition) => definition.name)).not.toContain("Plan");
		expect(registryResult.value.resolve("plan")).toEqual({
			ok: false,
			error: "agent type is disabled: Plan",
		});
	});

	it("rejects duplicate canonical names within one source", () => {
		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
			defaultDefinitions: [
				{
					name: "Explore",
					description: "Explore One",
					instructions: "One.",
				},
				{
					name: "explore",
					description: "Explore Two",
					instructions: "Two.",
				},
			],
		});
		expect(registryResult).toEqual({
			ok: false,
			error: "default agent definitions contain a duplicate canonical name: explore",
		});
	});
});

describe("AgentDefinitionRegistry.refresh", () => {
	it("returns a validation error for malformed constructor options instead of throwing", () => {
		const registry = new AgentDefinitionRegistry(null as unknown as ConstructorParameters<typeof AgentDefinitionRegistry>[0]);
		expect(registry.refresh()).toEqual({
			ok: false,
			error: "agent definition registry options must be an object",
		});
	});

	it("does not poison previously loaded definitions when a later refresh fails", () => {
		const registry = makeRegistry();
		const firstRefresh = registry.refresh();
		expect(firstRefresh.ok).toBe(true);
		expect(registry.resolve("Plan").ok).toBe(true);

		writeProjectAgent(
			"broken",
			`---
description: Broken
model: anthropic/claude-sonnet
---

Broken definition.`,
		);

		const secondRefresh = registry.refresh();
		expect(secondRefresh).toEqual({
			ok: false,
			error: "unsupported agent definition field: model",
		});

		const resolvedResult = registry.resolve("Plan");
		expect(resolvedResult.ok).toBe(true);
		if (!resolvedResult.ok) {
			return;
		}

		expect(resolvedResult.value.name).toBe("Plan");
		expect(registry.listAvailableDefinitions().map((definition) => definition.name)).toContain("Plan");
	});
});

describe("composeNamedSubagentInitialPrompt", () => {
	it("uses the resolved overridden general-purpose base for append mode", () => {
		writeProjectAgent(
			"general-purpose",
			`---
description: Overridden base
---

Use the project-specific base instructions first.`,
		);
		writeProjectAgent(
			"auditor",
			`---
description: Security auditor
prompt_mode: append
---

Look for security problems first.`,
		);
		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) {
			return;
		}

		const resolvedResult = registryResult.value.resolve("auditor");
		expect(resolvedResult.ok).toBe(true);
		if (!resolvedResult.ok) {
			return;
		}

		const promptResult = composeNamedSubagentInitialPrompt(resolvedResult.value, "Review the auth flow.");
		expect(promptResult.ok).toBe(true);
		if (!promptResult.ok) {
			return;
		}

		expect(promptResult.value).toContain("Use the project-specific base instructions first.");
		expect(promptResult.value).not.toContain("You are a general-purpose coding agent for complex, multi-step tasks.");
		expect(promptResult.value).toContain("Look for security problems first.");
	});

	it("supports append mode by combining the general-purpose base with custom instructions", () => {
		writeProjectAgent(
			"auditor",
			`---
description: Security auditor
prompt_mode: append
---

Look for security problems first.`,
		);
		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) {
			return;
		}

		const resolvedResult = registryResult.value.resolve("auditor");
		expect(resolvedResult.ok).toBe(true);
		if (!resolvedResult.ok) {
			return;
		}

		const promptResult = composeNamedSubagentInitialPrompt(resolvedResult.value, "Review the auth flow.");
		expect(promptResult.ok).toBe(true);
		if (!promptResult.ok) {
			return;
		}

		expect(promptResult.value).toContain("general-purpose coding agent");
		expect(promptResult.value).toContain("Look for security problems first.");
		expect(promptResult.value).toContain("Task:\nReview the auth flow.");
	});

	it("returns a validation error for malformed definition input instead of throwing", () => {
		expect(
			composeNamedSubagentInitialPrompt(null as unknown as Parameters<typeof composeNamedSubagentInitialPrompt>[0], "Review auth."),
		).toEqual({
			ok: false,
			error: "resolved agent definition must be an object",
		});
	});
});

describe("prepareNamedSubagentSpawn", () => {
	it("prepares a real validated spawn request from a named type", () => {
		writeProjectAgent(
			"auditor",
			`---
description: Security auditor
---

Review the code for security issues.`,
		);
		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) {
			return;
		}

		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrapConfigPath = path.join(runtimeDir, "auditor.bootstrap.json");
		const preparedResult = prepareNamedSubagentSpawn({
			registry: registryResult.value,
			type: "AUDITOR",
			description: "Audit auth flow",
			taskPrompt: "Inspect the authentication flow for vulnerabilities.",
			agentId: "agt_auditor",
			sessionPath: path.join(runtimeDir, "auditor.session.jsonl"),
			socketPath: path.join(runtimeDir, "auditor.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.1",
			bootstrapConfigPath,
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
		});
		expect(preparedResult.ok).toBe(true);
		if (!preparedResult.ok) {
			return;
		}

		expect(preparedResult.value.definition.name).toBe("auditor");
		expect(preparedResult.value.request.type).toBe("auditor");
		expect(preparedResult.value.request.description).toBe("Audit auth flow");
		expect(preparedResult.value.initialPrompt).toContain("Review the code for security issues.");
		expect(preparedResult.value.initialPrompt).toContain("Task:\nInspect the authentication flow for vulnerabilities.");
		expect(preparedResult.value.launchSpec.initialPrompt).toBe(preparedResult.value.initialPrompt);
		expect(fs.existsSync(bootstrapConfigPath)).toBe(true);

		const persistedBootstrap = JSON.parse(fs.readFileSync(bootstrapConfigPath, "utf8")) as Record<string, unknown>;
		expect(persistedBootstrap.initialPrompt).toBe(preparedResult.value.initialPrompt);
	});

	it("hard-fails for unknown or disabled types before writing bootstrap state", () => {
		writeProjectAgent(
			"auditor",
			`---
description: Security auditor
enabled: false
---
`,
		);
		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) {
			return;
		}

		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const disabledPath = path.join(runtimeDir, "disabled.bootstrap.json");
		const disabledResult = prepareNamedSubagentSpawn({
			registry: registryResult.value,
			type: "auditor",
			description: "Audit auth flow",
			taskPrompt: "Inspect auth.",
			agentId: "agt_disabled",
			sessionPath: path.join(runtimeDir, "disabled.session.jsonl"),
			socketPath: path.join(runtimeDir, "disabled.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.1",
			bootstrapConfigPath: disabledPath,
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
		});
		expect(disabledResult).toEqual({
			ok: false,
			error: "agent type is disabled: auditor",
		});
		expect(fs.existsSync(disabledPath)).toBe(false);

		const unknownPath = path.join(runtimeDir, "unknown.bootstrap.json");
		const unknownResult = prepareNamedSubagentSpawn({
			registry: registryResult.value,
			type: "missing",
			description: "Missing type",
			taskPrompt: "Inspect auth.",
			agentId: "agt_missing",
			sessionPath: path.join(runtimeDir, "missing.session.jsonl"),
			socketPath: path.join(runtimeDir, "missing.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.1",
			bootstrapConfigPath: unknownPath,
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
		});
		expect(unknownResult).toEqual({
			ok: false,
			error: "unknown agent type: missing",
		});
		expect(fs.existsSync(unknownPath)).toBe(false);
	});

	it("returns validation errors for malformed registry-like or writer inputs instead of throwing", () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrapConfigPath = path.join(runtimeDir, "malformed.bootstrap.json");

		const malformedRegistryResult = prepareNamedSubagentSpawn({
			registry: null as unknown as AgentDefinitionRegistry,
			type: "general-purpose",
			description: "Malformed registry",
			taskPrompt: "Inspect auth.",
			agentId: "agt_malformed_registry",
			sessionPath: path.join(runtimeDir, "malformed.session.jsonl"),
			socketPath: path.join(runtimeDir, "malformed.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.1",
			bootstrapConfigPath,
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
		});
		expect(malformedRegistryResult).toEqual({
			ok: false,
			error: "registry must provide a resolve(name) function",
		});

		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) {
			return;
		}

		const malformedWriterResult = prepareNamedSubagentSpawn({
			registry: registryResult.value,
			type: "general-purpose",
			description: "Malformed writer",
			taskPrompt: "Inspect auth.",
			agentId: "agt_malformed_writer",
			sessionPath: path.join(runtimeDir, "writer.session.jsonl"),
			socketPath: path.join(runtimeDir, "writer.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.2",
			bootstrapConfigPath: path.join(runtimeDir, "writer.bootstrap.json"),
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
			writeBootstrapConfig: 42 as unknown as (bootstrapConfigPath: string, serializedConfig: string) => void,
		});
		expect(malformedWriterResult).toEqual({
			ok: false,
			error: "writeBootstrapConfig must be a function",
		});
	});

	it("returns validation errors for malformed registry resolve results instead of throwing", () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrapConfigPath = path.join(runtimeDir, "malformed-result.bootstrap.json");

		const nullResult = prepareNamedSubagentSpawn({
			registry: {
				resolve() {
					return null as unknown as ReturnType<AgentDefinitionRegistry["resolve"]>;
				},
			} as unknown as AgentDefinitionRegistry,
			type: "general-purpose",
			description: "Malformed result",
			taskPrompt: "Inspect auth.",
			agentId: "agt_malformed_result",
			sessionPath: path.join(runtimeDir, "malformed-result.session.jsonl"),
			socketPath: path.join(runtimeDir, "malformed-result.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.5",
			bootstrapConfigPath,
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
		});
		expect(nullResult).toEqual({
			ok: false,
			error: "registry.resolve must return a ValidationOutcome",
		});
		expect(fs.existsSync(bootstrapConfigPath)).toBe(false);

		const malformedSuccessPath = path.join(runtimeDir, "malformed-success.bootstrap.json");
		const malformedSuccessResult = prepareNamedSubagentSpawn({
			registry: {
				resolve() {
					return { ok: true, value: { name: "bad" } } as unknown as ReturnType<AgentDefinitionRegistry["resolve"]>;
				},
			} as unknown as AgentDefinitionRegistry,
			type: "general-purpose",
			description: "Malformed success result",
			taskPrompt: "Inspect auth.",
			agentId: "agt_malformed_success",
			sessionPath: path.join(runtimeDir, "malformed-success.session.jsonl"),
			socketPath: path.join(runtimeDir, "malformed-success.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.6",
			bootstrapConfigPath: malformedSuccessPath,
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
		});
		expect(malformedSuccessResult).toEqual({
			ok: false,
			error: "instructions must be a non-empty string",
		});
		expect(fs.existsSync(malformedSuccessPath)).toBe(false);

		const malformedSourcePath = path.join(runtimeDir, "malformed-source.bootstrap.json");
		const malformedSourceResult = prepareNamedSubagentSpawn({
			registry: {
				resolve() {
					return {
						ok: true,
						value: {
							name: "bad",
							displayName: "Bad",
							description: "Bad definition",
							instructions: "Do the work.",
							promptMode: "replace",
							enabled: true,
							source: "memory",
							requestedName: "bad",
							definitionPath: 42,
						},
					} as unknown as ReturnType<AgentDefinitionRegistry["resolve"]>;
				},
			} as unknown as AgentDefinitionRegistry,
			type: "general-purpose",
			description: "Malformed source result",
			taskPrompt: "Inspect auth.",
			agentId: "agt_malformed_source",
			sessionPath: path.join(runtimeDir, "malformed-source.session.jsonl"),
			socketPath: path.join(runtimeDir, "malformed-source.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.7",
			bootstrapConfigPath: malformedSourcePath,
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
		});
		expect(malformedSourceResult).toEqual({
			ok: false,
			error: 'source must be one of "default", "global", or "project"',
		});
		expect(fs.existsSync(malformedSourcePath)).toBe(false);
	});

	it("returns a validation error if registry.resolve throws instead of bubbling the throw", () => {
		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrapConfigPath = path.join(runtimeDir, "thrown-resolve.bootstrap.json");

		const thrownResolveResult = prepareNamedSubagentSpawn({
			registry: {
				resolve() {
					throw new Error("resolve exploded");
				},
			} as unknown as AgentDefinitionRegistry,
			type: "general-purpose",
			description: "Thrown resolve",
			taskPrompt: "Inspect auth.",
			agentId: "agt_thrown_resolve",
			sessionPath: path.join(runtimeDir, "thrown-resolve.session.jsonl"),
			socketPath: path.join(runtimeDir, "thrown-resolve.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.8",
			bootstrapConfigPath,
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
		});
		expect(thrownResolveResult).toEqual({
			ok: false,
			error: "failed to resolve agent type: resolve exploded",
		});
		expect(fs.existsSync(bootstrapConfigPath)).toBe(false);
	});

	it("best-effort removes a partially written bootstrap file if the writer throws", () => {
		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) {
			return;
		}

		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrapConfigPath = path.join(runtimeDir, "partial.bootstrap.json");
		const preparedResult = prepareNamedSubagentSpawn({
			registry: registryResult.value,
			type: "general-purpose",
			description: "Partial writer",
			taskPrompt: "Inspect auth.",
			agentId: "agt_partial_writer",
			sessionPath: path.join(runtimeDir, "partial.session.jsonl"),
			socketPath: path.join(runtimeDir, "partial.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.3",
			bootstrapConfigPath,
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
			writeBootstrapConfig(targetPath, serializedConfig) {
				fs.writeFileSync(targetPath, serializedConfig, "utf8");
				throw new Error("writer exploded");
			},
		});
		expect(preparedResult).toEqual({
			ok: false,
			error: "failed to write bootstrap config: writer exploded",
		});
		expect(fs.existsSync(bootstrapConfigPath)).toBe(false);
	});

	it("atomically refuses to reuse an existing bootstrap config path", () => {
		const registryResult = loadAgentDefinitionRegistry({
			cwd: fakeRepoDir,
			homeDir: fakeHomeDir,
		});
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) {
			return;
		}

		const runtimeDir = fs.mkdtempSync(path.join(fakeRepoDir, "runtime-"));
		const bootstrapConfigPath = path.join(runtimeDir, "existing.bootstrap.json");
		fs.writeFileSync(bootstrapConfigPath, "already here\n", "utf8");

		const preparedResult = prepareNamedSubagentSpawn({
			registry: registryResult.value,
			type: "general-purpose",
			description: "Existing path",
			taskPrompt: "Inspect auth.",
			agentId: "agt_existing_path",
			sessionPath: path.join(runtimeDir, "existing.session.jsonl"),
			socketPath: path.join(runtimeDir, "existing.sock"),
			tmuxMode: "pane",
			tmuxTarget: "main:2.4",
			bootstrapConfigPath,
			bootstrapExtensionPath: fakeBootstrapExtensionPath,
			cwd: fakeRepoDir,
		});
		expect(preparedResult).toEqual({
			ok: false,
			error: "bootstrapConfigPath must not already exist",
		});
		expect(fs.readFileSync(bootstrapConfigPath, "utf8")).toBe("already here\n");
	});
});
