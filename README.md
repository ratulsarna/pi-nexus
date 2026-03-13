# pi-nexus

Tmux-backed sub-agents for `pi`.

## What this is

This repo now contains the first real user-facing tmux sub-agent path for `pi`.

The idea is simple:
- sub-agents are real `pi` processes running in tmux
- tmux is the human surface
- a structured sidecar channel is the machine/orchestration surface
- if you jump into a live sub-agent and chat directly, the parent treats that as intervention metadata rather than scraping terminal text

## What you can do today

Today, the real v1 user path is available:
- load the parent extension into `pi`
- ask the main agent to call the `Agent` tool with a named subagent type
- list live subagents with `/subagents list`
- print the exact tmux attach action with `/subagents focus <agentId>`
- define named agent types through embedded or custom definitions

## Trying it right now

If you want to try the current implementation from this repo, the practical path is:

1. Install dependencies:
   `npm install`
2. Build the extension:
   `npm run build`
3. Load the parent extension into `pi`:
   `pi -e /absolute/path/to/pi-nexus/dist/parent-extension.js`
   or copy/link it into `~/.pi/agent/extensions/`
4. Start `pi`
5. Ask the main agent to use the `Agent` tool with a named type such as `general-purpose`, `Explore`, or `Plan`
6. Run `/subagents list`
7. Run `/subagents focus <agentId>` and use the returned `focusCommand` to jump into the live tmux child

This is the real first-user path, not just a repo-internal harness.

Prerequisites:
- `tmux` must be installed and usable
- `pi` must be available in your environment

The extension adds these user-facing surfaces:
- `Agent` tool
- `/subagents list`
- `/subagents focus <agentId>`

The default named agents are:
- `general-purpose`
- `Explore`
- `Plan`

## Defining your own agents

Named agent definitions are loaded from:
- `.pi/agents/*.md` in the current repo
- `~/.pi/agent/agents/*.md` globally

Supported frontmatter is intentionally strict:
- `description`
- `display_name`
- `prompt_mode`
- `enabled`

Unsupported legacy fields are rejected instead of being silently ignored.

Focus intentionally does not take over the current `pi` terminal. `/subagents focus <agentId>` prints the exact tmux attach action so you can jump into the live child yourself.

## For developers

This repo is still an extension package rather than a standalone CLI, but the parent extension in `dist/parent-extension.js` is now the supported v1 integration seam for normal `pi` usage.

If you want to validate the current implementation directly from this repo, these scripts are available:
- `npm run accept:rat-131`
- `npm run accept:rat-133`
- `npm run accept:rat-134`
- `npm run accept:rat-135`

For the acceptance scripts, these env vars can help force a particular `pi` binary when needed:
- `RAT131_PI_PATH`
- `RAT131_PI_BIN_DIR`

## Docs

- [docs/v1-spec.md](docs/v1-spec.md)
- [docs/sidecar-protocol-v1.md](docs/sidecar-protocol-v1.md)
- [docs/runtime-contract-v1.md](docs/runtime-contract-v1.md)

## Internal implementation references

- `src/agent-definitions.ts` - strict named-agent definition registry, custom loading, and named-type spawn preparation
- `src/contracts.ts` - runtime contract types and validation helpers
- `src/parent-extension.ts` - parent-side Pi extension entrypoint, Agent tool, and /subagents command surface
- `test/contracts.test.ts` - contract tests that lock the v1 behavior
