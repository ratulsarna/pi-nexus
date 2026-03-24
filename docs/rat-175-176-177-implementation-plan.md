# RAT-175 to RAT-177 Implementation Plan

## Summary

- Build the three Linear tickets as a clean stacked branch series on top of current `main`.
- Keep `pi-nexus` as the runtime truth and borrow only presentation improvements from `../pi-interactive-subagents`.
- Do not edit `pi-mono`, do not rely on unsupported sidebar widgets, and do not import planner/worker workflow semantics.

## Branch And PR Flow

- `ratulsarna/rat-175-dashboard-polish` from `main`
- `ratulsarna/rat-176-browser-workspace-polish` from `ratulsarna/rat-175-dashboard-polish`
- `ratulsarna/rat-177-result-messaging-polish` from `ratulsarna/rat-176-browser-workspace-polish`
- Open PRs in the same order with stacked bases, then rebase each remaining branch onto `main` after the lower PR merges.

## Ticket Order

### RAT-175

- Replace unsupported widget placement with a supported placement.
- Improve live/history widget scannability, state badges, and copy.
- Add explicit elapsed-time presentation grounded in `pi-nexus` runtime chronology and persisted UI snapshot state if needed.

### RAT-176

- Improve browser row hierarchy and workspace presentation in the native TUI.
- Better separate terminal output from explicit summary/state panes.
- Make live, degraded, stale, and historical states easier to distinguish.

### RAT-177

- Polish progress, final result, needs-input, and status messaging.
- Improve command output for `list`, `open`, `send`, and `interrupt`.
- Use explicit `progress`, `final_result`, `needs_input`, and runtime state as the only source of truth.

## Review And Verification Loop

- Implement one ticket at a time.
- Before review, run `npm run build`, `npm test`, and `npm run accept:rat-133`.
- After each ticket is locally green, spawn one review sub-agent, wait for its result immediately, validate findings, fix valid issues, and rerun verification.
- After the review pass is resolved, commit, push, and open the ticket PR before starting the next ticket.

## Defaults

- Treat current `main` as accepted baseline, including existing local UX work already merged there.
- Keep scope tight to presentation and message rendering improvements.
- If a change needs contract support, update docs, validation, and tests in the same ticket.
