# Runtime Contract V1

## Goal

Define the concrete v1 runtime shape for tmux-backed subagents.

This resolves the major runtime decision:

- child runtime is the normal interactive `pi` CLI
- subagent-specific behavior lives in a bootstrap extension
- tmux is the live human surface
- the sidecar is the machine/orchestration surface

## Child runtime shape

Each subagent is launched as:

```text
tmux target
  -> pi interactive CLI
    -> bootstrap extension loaded at startup
```

The child runtime is not:

- a custom embedded TUI
- an in-memory `AgentSession` hidden inside the parent
- a second observer process scraping terminal output

## Launch contract

The parent resolves all runtime inputs before launch and writes them into a bootstrap config file.

Required bootstrap fields:

- `agentId`
- `sessionPath`
- `socketPath`
- `tmuxMode`
- `tmuxTarget`
- `initialPrompt`
- `bootstrapExtensionPath`
- `cwd`
- `childMode`

The parent then launches:

```text
<absolute-pi-path> --session <sessionPath> --extension <bootstrapExtensionPath> -- <initialPrompt>
```

And sets:

```text
PI_SUBAGENT_BOOTSTRAP_CONFIG=<bootstrapConfigPath>
```

The child environment inherits the parent process environment and adds `PI_SUBAGENT_BOOTSTRAP_CONFIG=<bootstrapConfigPath>`.

The bootstrap extension reads that env var to discover the config file containing `agentId`, `socketPath`, and tmux metadata.

V1 child mode is always:

- `interactive-cli`

## Why this shape

This matches established `pi-mono` patterns:

- normal `pi` interactive UX inside tmux
- extension hooks for lifecycle and input handling
- no duplicated TUI implementation
- no terminal scraping for correctness

It also keeps the design DRY:

- one stock child runtime
- one bootstrap extension
- one reporting tool

## Bootstrap extension responsibilities

The bootstrap extension is the only subagent-specific logic inside the child.

It must:

- connect to the parent sidecar on `session_start`
- flush/close on `session_shutdown`
- detect submitted human prompts via the `input` event
- emit `user_intervened` metadata for those prompts
- register exactly one LLM-callable tool: `report_to_parent`

It must not:

- mirror the full transcript to the parent
- treat ordinary assistant text as authoritative machine output
- invent a second interactive surface

## Reporting tool contract

The child exposes one tool:

```text
report_to_parent({
  kind: "progress" | "final_result" | "needs_input",
  summary: string,
  data?: unknown | null
})
```

Rules:

- `summary` must be non-empty after trim
- `data` is optional and may be `null`
- `final_result` is terminal and may be sent once only
- after terminal completion, later reports are ignored or treated as violations by the parent

## User intervention contract

`user_intervened` is emitted only when:

- the source is a real interactive human prompt in the child session
- and the prompt was actually submitted

`user_intervened` is not emitted for:

- focusing or attaching to the tmux target
- raw typing that is never submitted
- parent-side `steer`
- parent-side `follow_up`
- extension-originated internal messages

Payload is metadata only:

```json
{
  "source": "tmux",
  "mode": "direct-chat",
  "inputSource": "interactive-user"
}
```

No transcript sync happens in v1.

## Runtime states

Allowed states:

- `starting`
- `connecting`
- `ready`
- `running`
- `waiting`
- `completed`
- `failed`
- `stopped`
- `degraded`

Terminal states:

- `completed`
- `failed`
- `stopped`

`degraded` means the live tmux child still exists but the parent can no longer trust sidecar orchestration.

## State transition rules

Examples of allowed transitions:

- `starting -> connecting`
- `connecting -> ready`
- `ready -> running`
- `running -> waiting`
- `waiting -> running`
- `running -> completed`
- `ready -> degraded`
- `degraded -> failed`

Examples of forbidden transitions:

- `starting -> ready`
- `connecting -> running`
- `completed -> running`
- `failed -> ready`

## Source of truth

The parent-side record is the source of truth for:

- lifecycle state
- latest explicit progress report
- final result
- user intervention metadata

The live tmux child is the source of truth for:

- real-time user-visible streaming
- direct human interaction
- the exact live interactive session

## Failure handling

### Tmux target creation fails

- spawn fails immediately
- no v1 fallback to in-memory runtime

### Child launches but never connects

- state becomes `failed`

### Sidecar dies after ready

- state becomes `degraded`
- parent no longer trusts orchestration correctness
- human can still inspect the tmux target manually

### Child exits

- state becomes `completed`, `failed`, or `stopped` depending on the recorded terminal cause

## Relationship to the protocol

This doc defines:

- what process is launched
- what the bootstrap extension owns
- what counts as user intervention
- how lifecycle is modeled

[docs/sidecar-protocol-v1.md](sidecar-protocol-v1.md) defines:

- transport
- handshake
- message envelopes
- parent control messages
- child lifecycle/report messages
