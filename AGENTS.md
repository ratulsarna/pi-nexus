# pi-nexus

## Local Runtime

- RAT-131 acceptance resolves `pi` in this order: `RAT131_PI_PATH`, `RAT131_PI_BIN_DIR`, local `node_modules/.bin`, sibling `../pi-mono/node_modules/.bin`, then `PATH`.

## Learning

- Contracts must model real execution, not just typed shapes. If a launch spec or persisted record cannot safely drive the runtime, the contract is incomplete even if TypeScript accepts it.
- Treat every persistence boundary as untyped input. Anything loaded from JSON, disk, sockets, tmux metadata, or external config must be validated deeply, including enums, nested payloads, timestamps, booleans, and semantic consistency.
- Validators must be total over malformed input. Rejecting bad external data is not enough if the validator can still throw before returning a `ValidationError`.
- Return normalized typed values after validation. Do not hand unknown-shaped input back to callers just because it passed checks.
- Terminal state must be monotonic. Once a subagent reaches a terminal outcome, later reports or conflicting record states should be rejected rather than tolerated.
- Cleanup must be best-effort, even after validation or state-transition failures. Do not let one bad record or normalization error prevent terminating processes, closing sockets, or cleaning up sibling runtimes.
- Register ownership before enabling re-entrant callbacks, and assume those callbacks may fire synchronously. Parent state should be able to observe connect, exit, or hook callbacks immediately without dropping lifecycle events.
- Never persist partial lifecycle state from external input before the full event is validated. Rejected messages must not poison later handling by mutating trust, terminal markers, or other control-flow state first.
- When deriving lifecycle timestamps, anchor them to accepted record chronology rather than raw wall-clock time. New failure, stop, or degrade timestamps must remain monotonic with already-accepted history.
- Protocol handlers must define duplicate-delivery behavior explicitly. If retransmits or stale sequence numbers are expected, handle them as safe no-ops instead of escalating normal at-least-once delivery into failures.
- Keep docs, contract helpers, and tests in sync. In this repo, a design is only real once the prose, validation logic, and edge-case tests all agree.
- Constructors and validators must agree. Helpers that create contract objects should either guarantee validator-compatible output or fail early under the same rules.
- Validate wrapper/runtime assumptions explicitly. When this repo launches or orchestrates `pi`, details like argv shape, env inheritance, required flags, and bootstrap discovery should be enforced here rather than assumed.
- For process-launch contracts, environment is part of the API. Command resolution, args, cwd, env inheritance, and extension wiring must be validated together.
- For persisted launch contracts, path syntax is not enough. If execution depends on a path existing now, validate it against the real filesystem instead of only checking that it looks absolute.
- When two artifacts define one runtime, validate both shape and cross-artifact consistency. Independent validation of each side is not enough if they can drift from each other.
- For bind/create endpoints, validate availability, not just syntax. A path can be absolute and well-formed but still be unusable because the target is already occupied.
- Lifecycle contracts need chronology checks, not just timestamp format checks. Well-formed timestamps can still describe impossible runtime histories.
- Treat contract-boundary tickets as hardening work, not ordinary feature work. Start with an edge-case matrix covering shape, presence, filesystem reality, lifecycle state, and chronology, and expect a longer review tail than a normal feature ticket.
