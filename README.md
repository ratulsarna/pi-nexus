# pi-nexus

Tmux-backed sub-agents for `pi`.

This repo starts with executable contracts before the runtime.

Docs:

- [docs/v1-spec.md](docs/v1-spec.md)
- [docs/sidecar-protocol-v1.md](docs/sidecar-protocol-v1.md)
- [docs/runtime-contract-v1.md](docs/runtime-contract-v1.md)

Code:

- `src/agent-definitions.ts` - strict named-agent definition registry, custom loading, and named-type spawn preparation
- `src/contracts.ts` - runtime contract types and validation helpers
- `test/contracts.test.ts` - contract tests that lock the v1 behavior

Agent definitions:

- Embedded defaults are available through the explicit registry load/refresh surface.
- Custom definitions are loaded from `.pi/agents/*.md` in the repo and `~/.pi/agent/agents/*.md` globally.
- Supported frontmatter is intentionally strict and limited to runtime-real fields: `description`, `display_name`, `prompt_mode`, and `enabled`.
- Unsupported legacy fields are rejected instead of being silently ignored.
- Named-type spawning is prepared outside the lifecycle manager and returns a normal validated spawn request for the existing tmux-native runtime path.
