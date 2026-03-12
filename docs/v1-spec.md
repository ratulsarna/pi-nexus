# V1 Spec

## Goal

Build tmux-backed sub-agents for `pi` where each sub-agent is:

- a real `pi` process
- started from the beginning in tmux
- attachable mid-turn without losing live state
- directly interactable by the user
- still orchestratable by the parent agent

## Non-goals

- preserving compatibility with the current in-memory `pi-subagents` runtime
- replaying ordinary sub-agent chat into the parent as if it were machine output
- long-lived sub-agents beyond the current main-agent lifecycle

## Core principles

1. Human visibility and machine orchestration are separate concerns.
2. Tmux is the human surface.
3. A structured sidecar channel is the machine surface.
4. The parent trusts explicit reports, not scraped terminal output.
5. User intervention is metadata by default, not transcript sync.

## High-level architecture

```text
Main pi session
    |
    | Agent(...)
    v
Subagent Manager
    |
    +---- create tmux target (pane or window)
    |
    +---- launch sub-agent process
    |
    +---- attach sidecar controller/report channel
    v
Sub-agent runtime
```

```text
+-------------------+        structured reports        +------------------+
| Parent agent      | <------------------------------ | Sub-agent sidecar |
+-------------------+                                  +------------------+
          |                                                      |
          | orchestrate / steer                                  |
          v                                                      v
+-------------------+     live terminal UI in tmux     +------------------+
| User              | <-------------------------------> | pi sub-agent      |
+-------------------+                                   +------------------+
```

## V1 runtime model

Each sub-agent is launched immediately as the normal interactive `pi` CLI inside tmux, with a bootstrap extension that connects the child session to the parent sidecar.

V1 components:

- `SubagentManager`
  - owns agent records
  - spawns tmux targets
  - launches sub-agent runtimes
  - tracks lifecycle
- `TmuxController`
  - create pane/window
  - focus/attach
  - capture identifiers
- `SubagentRuntime`
  - launches stock interactive `pi`
  - loads the bootstrap extension
  - hosts the sidecar reporting/control layer
- `ParentBridge`
  - receives explicit reports from sub-agents
  - exposes parent-facing status and result APIs

## Why sub-agents must start in tmux

The user wants to attach to the exact live sub-agent mid-turn, while it is:

- streaming
- using tools
- thinking
- waiting for more work or input

That is only possible if the sub-agent already exists as a live tmux-backed process.

See [runtime-contract-v1.md](runtime-contract-v1.md) for the concrete child runtime contract and [sidecar-protocol-v1.md](sidecar-protocol-v1.md) for the protocol.

## Parent-facing data model

```text
SubagentRecord
- id
- type
- description
- state
- tmuxTarget
- tmuxMode             // pane | window
- sessionPath
- socketPath
- childMode
- createdAt
- startedAt
- connectedAt?
- stoppedAt?
- degradedAt?
- lastProgressReport?
- pendingInputRequest?
- finalResult?
- finalResultHistory?
- userIntervenedHistory?
- error?
```

Conversational posture values:

- `starting`
- `connecting`
- `ready`
- `running`
- `waiting`
- `needs_input`
- `failed`
- `stopped`

Separate trust condition:

- `degradedAt`
  - indicates the parent no longer trusts the sidecar connection
  - does not replace the conversational posture

## Reporting model

The parent never infers result state from terminal text.

The sub-agent reports through explicit messages only.

### V1 report types

```text
progress
- summary
- optional structured metadata

final_result
- summary
- optional structured metadata
- non-terminal current best answer
- may be emitted multiple times
- every accepted entry is preserved in `finalResultHistory`
- the latest accepted entry is mirrored in `finalResult`

needs_input
- question or blocker

user_intervened
- metadata only
- history only
```

### Critical rule

Normal user/sub-agent chat inside tmux is local to the sub-agent session.

If the user directly interacts with the sub-agent:

- the parent gets `user_intervened`
- the parent does not receive the transcript automatically
- the parent waits for the next explicit `progress` or `final_result`
- `user_intervened` is only emitted on positive evidence of submitted direct input

This prevents direct chat from being mistaken as the machine result.

## Control model

### User controls

- observe sub-agent
  - focus the live tmux target
- interact with sub-agent
  - type directly in the live tmux target
- return to parent
  - switch focus back to the main session

### Parent controls

- spawn sub-agent
- request focus target info
- send steer/follow-up through the sidecar control path
- interrupt current work through the sidecar control path
- poll or subscribe to explicit reports

## Chronology rule

When parent and user both send input, ordering is chronological.

No priority model in V1 beyond arrival order.

## Visibility model

Spawn behavior is configurable:

- `pane`
- `window`

Visibility policy can also be configurable later, but V1 always launches in tmux immediately so live attach works.

## Session model

Each sub-agent has its own persisted `pi` session file for the lifetime of the main-agent run.

The user attaches to the exact live tmux target, not to a reconstructed view of the same session.

## Lifecycle

```text
spawn request
  -> create record
  -> create tmux target
  -> start sub-agent runtime
  -> connect sidecar
  -> accept explicit child-authored posture updates
  -> emit progress/final_result/needs_input/user_intervened events
  -> remain conversational until child stops or the parent shuts down
  -> cleanup when main-agent lifecycle ends
```

## Failure behavior

### If tmux target creation fails

- sub-agent spawn fails
- no fallback to in-memory mode in V1

### If sub-agent process dies

- clean exit marks the session `stopped`
- child error or abnormal exit marks the session `failed`
- keep tmux metadata if useful for debugging

### If sidecar channel dies but tmux process lives

- mark the record degraded via `degradedAt`
- preserve the last child-authored conversational posture
- parent stops trusting it for orchestration
- user may still inspect the pane manually

## V1 scope boundary

V1 should include:

- spawn into tmux pane/window
- focus/attach UX
- explicit progress/final reporting
- repeated non-terminal `final_result` history with cheap current-best access
- explicit child-authored `running` / `waiting` / `needs_input`
- metadata-only user intervention signaling
- cleanup with main-agent lifecycle

V1 should exclude:

- transcript syncing into parent
- restart/recovery across separate main-agent runs
- compatibility fallback to the old in-memory sub-agent model

## Repo strategy

This repo is greenfield for runtime architecture.

We may later copy or adapt ideas from the old `pi-subagents` project:

- agent definitions
- config loading
- command/menu concepts

But V1 does not inherit the old in-memory execution engine.

The next implementation tickets should build against the executable contract module and tests in `src/contracts.ts` and `test/contracts.test.ts`.
