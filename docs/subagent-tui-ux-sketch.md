# Subagent TUI UX Sketch

## Problem

The current child transition UX is too low-level.

The user asks to open a subagent and we print a tmux command to run manually.
That exposes infrastructure instead of giving the user a real TUI interaction.

## Direction

The `pi` TUI should be the primary surface.
Tmux can stay as a runtime/detail layer, but it should not be the user-facing navigation model.

## User Actions

Every live subagent should support three direct actions in the TUI:

- `Peek`: read-only live preview without leaving the parent
- `Follow`: split view with parent and child visible together
- `Take Over`: full direct child chat mode

The current "print a focus command" flow should move to an `Advanced` or fallback path.

## Main TUI Model

The parent session should show a subagent list with:

- name
- posture: `running`, `waiting`, `needs_input`, `failed`
- trust marker: `stale`, `degraded`
- latest explicit summary
- actions: `Peek`, `Follow`, `Take Over`, `Send`, `Interrupt`

## Child Modes

### Peek

Read-only live child output in a panel, drawer, or modal.
No direct input.

### Follow

Split-pane mode.
Parent remains visible while the child streams live beside it.

### Take Over

Full child-focused mode for direct chat.
This mode must have a strong visual banner:

`Direct child chat. Parent assumptions are stale until the next explicit child report.`

There must always be a one-step path back to the parent.

## State Signals

The TUI should make these states obvious:

- `stale`: user talked directly to the child; parent summary may be outdated
- `degraded`: live child may still exist, but orchestration trust is reduced
- `needs_input`: child is blocked and waiting

## Implementation Bias

Preferred approach:

1. Keep tmux as backend plumbing for now
2. Move child open/focus into native TUI actions
3. Treat raw tmux attach commands as debug fallback only

Longer term, the best UX is likely a native PTY/session surface in `pi`, with tmux optional for persistence and recovery rather than primary navigation.
