# pi-nexus

## Learning

- Contracts must model real execution, not just typed shapes. If a launch spec or persisted record cannot safely drive the runtime, the contract is incomplete even if TypeScript accepts it.
- Treat every persistence boundary as untyped input. Anything loaded from JSON, disk, sockets, tmux metadata, or external config must be validated deeply, including enums, nested payloads, timestamps, booleans, and semantic consistency.
- Validators must be total over malformed input. Rejecting bad external data is not enough if the validator can still throw before returning a `ValidationError`.
- Return normalized typed values after validation. Do not hand unknown-shaped input back to callers just because it passed checks.
- Terminal state must be monotonic. Once a subagent reaches a terminal outcome, later reports or conflicting record states should be rejected rather than tolerated.
- Keep docs, contract helpers, and tests in sync. In this repo, a design is only real once the prose, validation logic, and edge-case tests all agree.
- Constructors and validators must agree. Helpers that create contract objects should either guarantee validator-compatible output or fail early under the same rules.
- Validate wrapper/runtime assumptions explicitly. When this repo launches or orchestrates `pi`, details like argv shape, env inheritance, required flags, and bootstrap discovery should be enforced here rather than assumed.
- For process-launch contracts, environment is part of the API. Command resolution, args, cwd, env inheritance, and extension wiring must be validated together.
- For persisted launch contracts, path syntax is not enough. If execution depends on a path existing now, validate it against the real filesystem instead of only checking that it looks absolute.
- When two artifacts define one runtime, validate both shape and cross-artifact consistency. Independent validation of each side is not enough if they can drift from each other.
- For bind/create endpoints, validate availability, not just syntax. A path can be absolute and well-formed but still be unusable because the target is already occupied.
- Lifecycle contracts need chronology checks, not just timestamp format checks. Well-formed timestamps can still describe impossible runtime histories.
- Treat contract-boundary tickets as hardening work, not ordinary feature work. Start with an edge-case matrix covering shape, presence, filesystem reality, lifecycle state, and chronology, and expect a longer review tail than a normal feature ticket.
