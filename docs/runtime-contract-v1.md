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
The persisted launch spec must also carry the same initial prompt so validation can detect drift between the saved launch record and the bootstrap file the child will actually read.

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
<absolute-pi-path> --session <sessionPath> --extension <bootstrapExtensionPath>
```

And sets:

```text
PI_SUBAGENT_BOOTSTRAP_CONFIG=<bootstrapConfigPath>
```

The child environment inherits the parent process environment and adds `PI_SUBAGENT_BOOTSTRAP_CONFIG=<bootstrapConfigPath>`.
That inheritance rule applies at creation time. Persisted launch-spec validation checks the serialized env needed to launch, not whether it still exactly matches the validator's current process environment after a restart.

The bootstrap extension reads that env var to discover the config file containing `agentId`, `socketPath`, tmux metadata, and the initial prompt.

V1 does not rely on positional argv for `initialPrompt`. The real `pi-mono` parser does not support `--` as a general end-of-options transport for arbitrary startup text, so the initial prompt must be injected by the bootstrap extension after startup using the bootstrap config as the source of truth.

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
- reports are not accepted while the child is still `starting` or `connecting`
- reports are not accepted once the runtime is `stopped`
- `failed` is non-terminal, so later accepted reports may move the session back into active conversational posture
- `final_result` is non-terminal and may be sent multiple times
- every accepted `final_result` appends to `finalResultHistory`
- the latest accepted `final_result` is mirrored in `finalResult` as the cheap current-best view

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

When `user_intervened` is accepted, the parent records `assumptionsStaleAt` and treats prior child understanding as potentially stale until a newer accepted explicit child-authored `progress`, `needs_input`, or `final_result` arrives.

## Runtime states

Allowed states:

- `starting`
- `connecting`
- `ready`
- `running`
- `waiting`
- `needs_input`
- `failed`
- `stopped`

Terminal states:

- `stopped`

`degraded` is not a runtime state. It is a separate trust marker recorded as `degradedAt` when the live tmux child may still exist but the parent can no longer trust sidecar orchestration.

Posture rules:

- `running` means the child says it is actively working and no `final_result` has yet been produced for the current stretch of work
- `waiting` means no result is currently expected and the session is still open for more work
- `needs_input` means the child is waiting for explicit user input, with details stored separately in `pendingInputRequest`
- `failed` means the child reported an error condition, but the session is still non-terminal until it later recovers or stops

## State transition rules

Examples of allowed transitions:

- `starting -> connecting`
- `connecting -> ready`
- `ready -> running`
- `ready -> waiting`
- `ready -> needs_input`
- `running -> waiting`
- `running -> needs_input`
- `waiting -> running`
- `waiting -> needs_input`
- `needs_input -> running`
- `failed -> running`
- `failed -> waiting`
- `failed -> needs_input`

Examples of forbidden transitions:

- `starting -> ready`
- `connecting -> running`
- `stopped -> running`
- `failed -> ready`
- `needs_input -> ready`

## Source of truth

The parent-side record is the source of truth for:

- lifecycle state
- latest explicit progress report
- latest explicit needs-input request
- cheap current-best final result
- append-only `finalResultHistory`
- append-only `userIntervenedHistory`
- degraded trust marker
- `assumptionsStaleAt`

The parent-side focus surface is also the supported source of truth for:

- structured tmux focus metadata
- one ready-to-run focus/attach command for the child target
- explicit focus availability semantics:
  - `live`
  - `degraded`
  - `stopped` (historical / non-live)

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

- conversational posture stays at the last accepted child-authored state
- `degradedAt` is recorded separately
- parent no longer trusts orchestration correctness
- human can still inspect the tmux target manually

### Child reports `error` or `failed`

- state becomes `failed`
- pending input clears
- the session is still non-terminal
- later accepted child reports or state updates may move the session back to `running`, `waiting`, or `needs_input`

### Child exits

- clean exit becomes `stopped`
- abnormal exit becomes `failed`

### Parent `interrupt`

- `interrupt` is the authoritative control vocabulary at the contract boundary
- sending `interrupt` alone does not authorize the parent to rewrite posture
- once the child has successfully honored the interrupt, the resulting accepted lifecycle update clears any pending input request
- once the child has successfully honored the interrupt, the resulting accepted lifecycle update moves posture to `waiting`

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
