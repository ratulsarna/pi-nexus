# Sidecar Protocol V1

## Goal

Define the machine-facing protocol between:

- the parent-side `SubagentManager`
- the sub-agent runtime running inside tmux

The protocol exists so the parent can orchestrate sub-agents reliably without scraping terminal output.

## Non-goals

- mirroring the full sub-agent transcript to the parent
- replacing the human tmux UI
- supporting arbitrary remote transport in V1

## Core model

The sidecar is a local structured channel.

V1 assumptions:

- parent and sub-agent run on the same machine
- the sub-agent is launched by the parent
- every sub-agent has exactly one parent
- transport is local and ephemeral

## Recommended transport

Use newline-delimited JSON over a local Unix domain socket.

Why:

- local-only and simple
- bidirectional
- no shell quoting issues
- no terminal-state dependence
- easier to reason about than tmux keystrokes

V1 alternatives like stdout scraping or tmux buffer inspection are explicitly out of scope.

## Ownership

For each sub-agent, the parent creates:

- `agentId`
- `sessionPath`
- `socketPath`
- tmux target metadata

Then the parent launches the sub-agent runtime with those values.

## High-level flow

```text
parent creates socket
  -> parent launches sub-agent in tmux
  -> sub-agent connects to socket
  -> handshake completes
  -> parent sends control messages
  -> sub-agent sends reports/events
  -> either side closes
```

## Envelope

All messages are JSON objects, one per line.

Common envelope:

```json
{
  "version": 1,
  "agentId": "agt_123",
  "type": "progress",
  "seq": 12,
  "time": "2026-03-10T10:00:00.000Z",
  "payload": {}
}
```

Fields:

- `version`
  - protocol version
- `agentId`
  - stable per-sub-agent id
- `type`
  - message kind
- `seq`
  - monotonically increasing per sender
- `time`
  - ISO timestamp
- `payload`
  - message body

## Message directions

```text
parent  -> sub-agent : control messages
sub-agent -> parent  : reports and lifecycle events
```

## Parent -> sub-agent messages

### `hello`

Sent once after connection.

Purpose:

- confirm expected agent identity
- communicate runtime defaults

Payload:

```json
{
  "sessionPath": "/abs/path/session.jsonl",
  "tmuxTarget": "mysession:2.1",
  "mode": "pane"
}
```

### `steer`

Request that the sub-agent process a steering message.

Payload:

```json
{
  "message": "Stop searching and summarize the auth flow."
}
```

### `follow_up`

Queue a follow-up message after the current active work settles.

Payload:

```json
{
  "message": "After that, check tests too."
}
```

### `interrupt`

Request interruption of the current work stretch while keeping the session open.

Payload:

```json
{}
```

Rules:

- authoritative protocol vocabulary uses `interrupt`
- sending `interrupt` does not let the parent guess posture from transport success alone
- once the child has successfully honored the interrupt, the resulting accepted lifecycle update clears any pending input request and moves posture to `waiting`

### `ping`

Health check / liveness probe.

Payload:

```json
{}
```

## Sub-agent -> parent messages

### `ready`

Sent once after startup and successful handshake.

Payload:

```json
{
  "pid": 12345,
  "sessionPath": "/abs/path/session.jsonl",
  "tmuxTarget": "mysession:2.1"
}
```

### `progress`

Explicit machine-facing progress update.

Payload:

```json
{
  "summary": "Mapped auth entry points and found 3 middleware files.",
  "data": {
    "files": [
      "/repo/src/auth.ts",
      "/repo/src/middleware/session.ts"
    ]
  }
}
```

Rules:

- optional
- may be sent multiple times
- parent may display this as status or intermediate result

### `final_result`

Explicit current-best result.

Payload:

```json
{
  "summary": "Auth flow documented and risky middleware highlighted.",
  "data": {
    "findings": 2
  }
}
```

Rules:

- non-terminal
- may be sent multiple times
- every accepted entry is preserved in append-only history
- the latest accepted entry is the current best answer for parent-facing reads

### `needs_input`

Structured blocker or question.

Payload:

```json
{
  "question": "Should I change the middleware or only document it?",
  "kind": "decision"
}
```

### `user_intervened`

Metadata that the human directly interacted with the sub-agent.

Payload:

```json
{
  "source": "tmux",
  "mode": "direct-chat"
}
```

Rules:

- no transcript included by default
- emitted only on positive evidence of submitted direct user input in the child session
- parent marks previous assumptions as potentially stale
- parent waits for the next explicit `progress` or `final_result`

### `state`

Lifecycle state update.

Payload:

```json
{
  "status": "running"
}
```

Allowed statuses:

- `starting`
- `running`
- `waiting`
- `needs_input`
- `failed`
- `stopped`

Rules:

- these statuses are child-authored lifecycle posture, not parent inference
- `final_result` is history data, not a `state.status`
- `failed` is non-terminal at the session level

### `error`

Structured error report.

Payload:

```json
{
  "message": "RPC bridge disconnected",
  "fatal": true
}
```

Rules:

- moves parent posture to `failed`
- clears any pending input request
- does not by itself terminate the session

### `pong`

Response to `ping`.

Payload:

```json
{}
```

## Handshake

```text
1. parent opens socket and waits
2. parent launches sub-agent runtime in tmux
3. sub-agent connects
4. parent sends hello
5. sub-agent validates agentId/sessionPath
6. sub-agent sends ready
7. protocol becomes active
```

If handshake fails:

- parent marks agent as failed
- parent does not trust the tmux process as orchestratable

## Delivery semantics

V1 delivery is at-least-once from the protocol perspective, with idempotency handled by `seq`.

Parent rules:

- ignore duplicate or old `seq` values from sub-agent
- process only increasing `seq` values per agent

Sub-agent rules:

- ignore duplicate or old `seq` values from parent

V1 does not require durable replay after parent restart because sub-agents die with the main-agent lifecycle.

## Ordering

Ordering is per connection, not global.

Chronology rule:

- whichever control message arrives first is processed first
- direct user interaction in tmux is outside protocol ordering
- when direct interaction happens, the sub-agent should emit `user_intervened` as soon as practical

## Reliability boundary

The sidecar is authoritative for:

- parent-visible progress
- current-best final result plus preserved `final_result` history
- explicit child-authored lifecycle posture
- user intervention metadata history

The tmux terminal is authoritative for:

- live human-visible interaction
- live streaming UI
- exact in-flight sub-agent experience

## Failure semantics

### Socket never connects

- parent marks sub-agent failed
- parent may show tmux target for manual debugging

### Socket disconnects after `ready`

- parent records degraded trust separately from conversational posture
- parent stops trusting future orchestration
- user may still inspect the live tmux target

### Sub-agent sends terminal output but no `final_result`

- parent does not infer success
- parent waits for `final_result`, `error`, or process exit

### Parent exits

- parent terminates all child sub-agents for V1
- sidecar is torn down

## Suggested implementation shape

```text
Parent:
- SubagentManager
- Unix socket server
- per-agent connection state

Sub-agent:
- pi runtime
- sidecar client
- bridge that converts local events into protocol messages
```

## Open implementation question

The main unresolved design choice is inside the sub-agent runtime:

How does it detect and emit `user_intervened` with acceptable accuracy?

Likely V1 answer:

- instrument the sub-agent launcher/runtime so user-originated messages are detectable locally
- emit metadata only
- do not attempt transcript sync
