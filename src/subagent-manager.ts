import {
	assertRuntimeStateTransition,
	createUserIntervenedMetadata,
	validateMonotonicSeqAcceptance,
	validateReportToParentInput,
	validateRuntimeLaunchSpec,
	validateSidecarControlMessage,
	validateSidecarEventMessage,
	validateSidecarHandshake,
	validateSubagentRecord,
	type ExplicitReport,
	type ParentControlKind,
	type RuntimeLaunchSpec,
	type RuntimeState,
	type SidecarControlMessage,
	type SidecarEventMessage,
	type SidecarProtocolMessage,
	type SidecarStateStatus,
	type SubagentRecord,
	type UserIntervenedMetadata,
	type ValidationError,
	type ValidationOutcome,
	type ValidationResult,
} from "./contracts.js";

export interface ManagedProcessExit {
	code: number | null;
	signal: string | null;
}

export interface ManagedSubagentSpawnRequest {
	type: string;
	description: string;
	launchSpec: RuntimeLaunchSpec;
}

export interface SidecarSessionHandlers<TData = unknown> {
	onConnect: () => ValidationOutcome<unknown>;
	onMessage: (message: unknown) => ValidationOutcome<unknown>;
	onDisconnect: (reason?: string) => ValidationOutcome<unknown>;
}

export interface SidecarSessionHandle<TData = unknown> {
	send(message: SidecarControlMessage<TData>): void;
	close(): void;
}

export interface SidecarSessionAdapter<TData = unknown> {
	openSession(socketPath: string, handlers: SidecarSessionHandlers<TData>): SidecarSessionHandle<TData>;
}

export interface SubagentProcessHandle {
	terminate(reason: "interrupt" | "shutdown"): void;
}

export interface SubagentProcessAdapter {
	launch(
		launchSpec: RuntimeLaunchSpec,
		handlers: { onExit: (exit: ManagedProcessExit) => ValidationOutcome<unknown> },
	): SubagentProcessHandle;
}

export interface SubagentManagerOptions<TData = unknown> {
	connectingTimeoutMs?: number;
	now?: () => string;
	sidecarSessions: SidecarSessionAdapter<TData>;
	runtimeProcesses: SubagentProcessAdapter;
	onSessionOpened?: (agentId: string, handle: SidecarSessionHandle<TData>) => void;
}

interface ManagedRuntime<TData = unknown> {
	record: SubagentRecord<TData>;
	launchSpec: RuntimeLaunchSpec;
	sidecar: SidecarSessionHandle<TData>;
	process: SubagentProcessHandle;
	lastInboundSeq?: number;
	lastOutboundSeq?: number;
	lastHello?: SidecarControlMessage<TData> & { type: "hello" };
	connectionOpen: boolean;
	connectingTimeoutHandle?: ReturnType<typeof setTimeout>;
	trusted: boolean;
	lastReportedState?: SidecarStateStatus;
	lastPostReadyDisconnect?: {
		reason?: string;
		degradedAt: string;
	};
}

function fail(error: string): ValidationError {
	return { ok: false, error };
}

function ok<T>(value: T): ValidationResult<T> {
	return { ok: true, value };
}

function isNonEmptyTrimmedString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function ensureCloneable<T>(value: T, field: string): ValidationOutcome<T> {
	try {
		return ok(structuredClone(value));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return fail(`${field} must be structured-cloneable: ${reason}`);
	}
}

function normalizeProcessExit(exit: ManagedProcessExit): ValidationOutcome<ManagedProcessExit> {
	if (typeof exit !== "object" || exit === null) {
		return fail("process exit must be an object");
	}
	if (exit.code !== null && (!Number.isSafeInteger(exit.code) || exit.code < 0)) {
		return fail("process exit code must be a non-negative safe integer or null");
	}
	if (exit.signal !== null && typeof exit.signal !== "string") {
		return fail("process exit signal must be a string or null");
	}

	return ok(exit);
}

function formatExitMessage(exit: ManagedProcessExit): string {
	if (exit.signal) {
		return `subagent process exited unexpectedly with signal ${exit.signal}`;
	}

	if (typeof exit.code === "number") {
		return `subagent process exited unexpectedly with code ${exit.code}`;
	}

	return "subagent process exited unexpectedly";
}

function normalizeRecord<TData>(record: unknown): ValidationOutcome<SubagentRecord<TData>> {
	if (typeof record !== "object" || record === null || Array.isArray(record)) {
		return validateSubagentRecord<TData>(record);
	}

	return validateSubagentRecord<TData>(stripUndefinedFields(record as Record<string, unknown>));
}

function stripUndefinedFields(value: Record<string, unknown>): Record<string, unknown> {
	const next: Record<string, unknown> = {};

	for (const [key, entry] of Object.entries(value)) {
		if (entry !== undefined) {
			next[key] = entry;
		}
	}

	return next;
}

function maxIsoTimestamp(first: string, second: string): string {
	return first >= second ? first : second;
}

function isTransientPreReadyDisconnectReason(reason: string | undefined): boolean {
	if (!reason?.trim()) {
		return true;
	}

	return /(EPIPE|ECONNRESET|socket hang up|broken pipe|write after end)/i.test(reason);
}

export class SubagentManager<TData = unknown> {
	private readonly runtimes = new Map<string, ManagedRuntime<TData>>();

	private readonly connectingTimeoutMs: number;

	private readonly now: () => string;

	public constructor(private readonly options: SubagentManagerOptions<TData>) {
		this.connectingTimeoutMs = options.connectingTimeoutMs ?? 30_000;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	private cleanupRuntimeRegistration(agentId: string, runtime: ManagedRuntime<TData>): void {
		this.clearConnectingTimeout(runtime);
		this.runtimes.delete(agentId);
		runtime.connectionOpen = false;
		runtime.trusted = false;
		try {
			runtime.process.terminate("shutdown");
		} catch {
			// Best-effort cleanup after registration failure.
		}
		try {
			runtime.sidecar.close();
		} catch {
			// Best-effort cleanup after registration failure.
		}
	}

	public spawn(request: ManagedSubagentSpawnRequest): ValidationOutcome<SubagentRecord<TData>> {
		if (!isRecord(request)) {
			return fail("spawn request must be an object");
		}
		if (!isNonEmptyTrimmedString(request.type)) {
			return fail("spawn request type must be a non-empty string");
		}
		if (!isNonEmptyTrimmedString(request.description)) {
			return fail("spawn request description must be a non-empty string");
		}

		const launchSpecResult = validateRuntimeLaunchSpec(request.launchSpec);
		if (!launchSpecResult.ok) return launchSpecResult;

		const launchSpec = launchSpecResult.value;
		if (this.runtimes.has(launchSpec.agentId)) {
			return fail(`agent is already managed: ${launchSpec.agentId}`);
		}
		for (const runtime of this.runtimes.values()) {
			if (runtime.launchSpec.socketPath === launchSpec.socketPath) {
				return fail(`socketPath is already managed by agent ${runtime.launchSpec.agentId}`);
			}
		}

		const createdAt = this.now();
		const startingRecordResult = normalizeRecord<TData>({
			id: launchSpec.agentId,
			type: request.type.trim(),
			description: request.description.trim(),
			state: "starting",
			tmuxMode: launchSpec.tmuxMode,
			tmuxTarget: launchSpec.tmuxTarget,
			sessionPath: launchSpec.sessionPath,
			socketPath: launchSpec.socketPath,
			childMode: launchSpec.childMode,
			createdAt,
			startedAt: createdAt,
		});
		if (!startingRecordResult.ok) return startingRecordResult;

		let sidecar: SidecarSessionHandle<TData>;
		let runtimeRegistered = false;
		const pendingCallbacks: Array<() => ValidationOutcome<unknown>> = [];
		const runOrQueue = (callback: () => ValidationOutcome<unknown>): ValidationOutcome<unknown> => {
			if (!runtimeRegistered) {
				pendingCallbacks.push(callback);
				return ok(undefined);
			}

			return callback();
		};
		try {
			sidecar = this.options.sidecarSessions.openSession(launchSpec.socketPath, {
				onConnect: () => runOrQueue(() => this.handleSidecarConnect(launchSpec.agentId)),
				onMessage: (message) => runOrQueue(() => this.handleSidecarMessage(launchSpec.agentId, message)),
				onDisconnect: (reason) => runOrQueue(() => this.handleSidecarDisconnect(launchSpec.agentId, reason)),
			});
		} catch (error) {
			return fail(`failed to open sidecar session: ${this.describeError(error)}`);
		}

		let process: SubagentProcessHandle;
		try {
			process = this.options.runtimeProcesses.launch(launchSpec, {
				onExit: (exit) => runOrQueue(() => this.handleProcessExit(launchSpec.agentId, exit)),
			});
		} catch (error) {
			try {
				sidecar.close();
			} catch {
				// Best-effort cleanup after launch failure.
			}
			return fail(`failed to launch subagent process: ${this.describeError(error)}`);
		}

		const connectingRecordResult = this.transitionRecord(startingRecordResult.value, "connecting");
		if (!connectingRecordResult.ok) {
			return connectingRecordResult;
		}

		const runtime: ManagedRuntime<TData> = {
			record: connectingRecordResult.value,
			launchSpec,
			sidecar,
			process,
			connectionOpen: false,
			trusted: false,
		};
		this.runtimes.set(launchSpec.agentId, runtime);
		runtimeRegistered = true;
		this.scheduleConnectingTimeout(launchSpec.agentId, runtime);
		try {
			this.options.onSessionOpened?.(launchSpec.agentId, sidecar);
		} catch (error) {
			this.cleanupRuntimeRegistration(launchSpec.agentId, runtime);
			return fail(`onSessionOpened failed: ${this.describeError(error)}`);
		}
		for (const callback of pendingCallbacks) {
			const callbackResult = callback();
			if (!callbackResult.ok) {
				this.cleanupRuntimeRegistration(launchSpec.agentId, runtime);
				return callbackResult;
			}
		}

		return ok(cloneValue(runtime.record));
	}

	public getRecord(agentId: string): ValidationOutcome<SubagentRecord<TData>> {
		const runtime = this.getRuntime(agentId);
		if (!runtime.ok) return runtime;
		return ok(cloneValue(runtime.value.record));
	}

	public listRecords(): ReadonlyArray<SubagentRecord<TData>> {
		return Array.from(this.runtimes.values(), (runtime) => cloneValue(runtime.record));
	}

	public handleSidecarConnect(agentId: string): ValidationOutcome<SubagentRecord<TData>> {
		const runtimeResult = this.getRuntime(agentId);
		if (!runtimeResult.ok) return runtimeResult;
		const runtime = runtimeResult.value;
		if (runtime.connectionOpen) {
			return fail(`sidecar is already connected for agent ${agentId}`);
		}
		if (this.isDegraded(runtime.record)) {
			return fail(`cannot reconnect sidecar for degraded agent ${agentId}`);
		}
		if (this.isTerminalReportedState(runtime.lastReportedState)) {
			return fail(`cannot reconnect sidecar after terminal child state for agent ${agentId}`);
		}
		if (this.isTerminal(runtime.record.state)) {
			return fail(`cannot connect sidecar for terminal agent ${agentId}`);
		}

		const helloResult = this.buildControlMessage(runtime, "hello", {
			sessionPath: runtime.launchSpec.sessionPath,
			tmuxTarget: runtime.launchSpec.tmuxTarget,
			mode: runtime.launchSpec.tmuxMode,
		});
		if (!helloResult.ok) return helloResult;

		try {
			runtime.sidecar.send(helloResult.value);
		} catch (error) {
			return fail(`failed to send hello: ${this.describeError(error)}`);
		}

		runtime.lastOutboundSeq = helloResult.value.seq;
		runtime.lastHello = helloResult.value as SidecarControlMessage<TData> & { type: "hello" };
		runtime.connectionOpen = true;
		return ok(cloneValue(runtime.record));
	}

	public handleSidecarMessage(agentId: string, message: unknown): ValidationOutcome<SubagentRecord<TData>> {
		const runtimeResult = this.getRuntime(agentId);
		if (!runtimeResult.ok) return runtimeResult;
		const runtime = runtimeResult.value;

		const eventResult = validateSidecarEventMessage<TData>(message);
		if (!eventResult.ok) return eventResult;
		const event = eventResult.value;
		if (event.agentId !== agentId) {
			return fail(`sidecar event agentId does not match managed agent ${agentId}`);
		}

		if (runtime.lastInboundSeq !== undefined && event.seq <= runtime.lastInboundSeq) {
			return ok(cloneValue(runtime.record));
		}

		const seqResult = validateMonotonicSeqAcceptance(event.seq, runtime.lastInboundSeq);
		if (!seqResult.ok) return seqResult;

		const applyResult = this.applyEvent(runtime, event);
		if (!applyResult.ok) return applyResult;

		runtime.lastInboundSeq = seqResult.value;
		return ok(cloneValue(runtime.record));
	}

	public handleSidecarDisconnect(agentId: string, reason?: string): ValidationOutcome<SubagentRecord<TData>> {
		const runtimeResult = this.getRuntime(agentId);
		if (!runtimeResult.ok) return runtimeResult;
		const runtime = runtimeResult.value;
		runtime.connectionOpen = false;
		runtime.trusted = false;

		if (this.isTerminalReportedState(runtime.lastReportedState)) {
			this.clearConnectingTimeout(runtime);
			return ok(cloneValue(runtime.record));
		}

		if (this.isTerminal(runtime.record.state)) {
			this.clearConnectingTimeout(runtime);
			return ok(cloneValue(runtime.record));
		}

		if (runtime.record.state === "failed" && runtime.record.connectedAt === undefined) {
			this.clearConnectingTimeout(runtime);
			return ok(cloneValue(runtime.record));
		}

		if (
			runtime.record.state === "ready"
			|| runtime.record.state === "running"
			|| runtime.record.state === "waiting"
			|| runtime.record.state === "needs_input"
			|| runtime.record.state === "failed"
		) {
			this.clearConnectingTimeout(runtime);
			const degradedAt = this.deriveTerminalTimestamp(runtime.record);
			const degradedResult = normalizeRecord<TData>({
				...runtime.record,
				degradedAt,
			});
			if (!degradedResult.ok) return degradedResult;
			runtime.record = degradedResult.value;
			runtime.lastPostReadyDisconnect = {
				reason,
				degradedAt,
			};
			return ok(cloneValue(runtime.record));
		}

		if (isTransientPreReadyDisconnectReason(reason)) {
			return ok(cloneValue(runtime.record));
		}

		this.clearConnectingTimeout(runtime);
		const failedResult = this.transitionRecord(runtime.record, "failed", {
			error: {
				message: reason
					? `sidecar disconnected before ready: ${reason}`
					: "sidecar disconnected before ready",
				recordedAt: this.deriveTerminalTimestamp(runtime.record),
				fatal: true,
			},
		});
		if (!failedResult.ok) return failedResult;
		runtime.record = failedResult.value;
		try {
			runtime.process.terminate("shutdown");
		} catch {
			// Best-effort cleanup after pre-ready sidecar disconnect.
		}
		try {
			runtime.sidecar.close();
		} catch {
			// Best-effort cleanup after pre-ready sidecar disconnect.
		}
		return ok(cloneValue(runtime.record));
	}

	public handleProcessExit(agentId: string, exit: ManagedProcessExit): ValidationOutcome<SubagentRecord<TData>> {
		const runtimeResult = this.getRuntime(agentId);
		if (!runtimeResult.ok) return runtimeResult;
		const runtime = runtimeResult.value;
		const exitResult = normalizeProcessExit(exit);
		if (!exitResult.ok) return exitResult;

		this.clearConnectingTimeout(runtime);
		if (this.isTerminal(runtime.record.state)) {
			return ok(cloneValue(runtime.record));
		}
		const terminalTimestamp = this.deriveTerminalTimestamp(runtime.record);
		const clearSilentDisconnectDegradedAt = runtime.lastPostReadyDisconnect !== undefined
			&& runtime.lastPostReadyDisconnect.reason === undefined
			&& runtime.lastPostReadyDisconnect.degradedAt === runtime.record.degradedAt;
		const cleanExitCanStop =
			runtime.record.state === "ready"
			|| runtime.record.state === "running"
			|| runtime.record.state === "waiting"
			|| runtime.record.state === "needs_input";

		if (exitResult.value.code === 0 && exitResult.value.signal === null && cleanExitCanStop) {
			const stoppedResult = this.transitionRecord(runtime.record, "stopped", {
				degradedAt: clearSilentDisconnectDegradedAt ? undefined : runtime.record.degradedAt,
				stoppedAt: terminalTimestamp,
			});
			if (!stoppedResult.ok) return stoppedResult;

			runtime.record = stoppedResult.value;
			runtime.lastPostReadyDisconnect = undefined;
			runtime.connectionOpen = false;
			runtime.trusted = false;
			return ok(cloneValue(runtime.record));
		}

		if (exitResult.value.code === 0 && exitResult.value.signal === null && runtime.record.state === "failed") {
			const normalizedFailedResult = normalizeRecord<TData>({
				...runtime.record,
				degradedAt: clearSilentDisconnectDegradedAt ? undefined : runtime.record.degradedAt,
			});
			if (!normalizedFailedResult.ok) return normalizedFailedResult;

			runtime.record = normalizedFailedResult.value;
			runtime.lastPostReadyDisconnect = undefined;
			runtime.connectionOpen = false;
			runtime.trusted = false;
			return ok(cloneValue(runtime.record));
		}

		const failedResult = this.transitionRecord(runtime.record, "failed", {
			degradedAt: clearSilentDisconnectDegradedAt ? undefined : runtime.record.degradedAt,
			error: {
				message: formatExitMessage(exitResult.value),
				recordedAt: terminalTimestamp,
				fatal: true,
			},
			pendingInputRequest: undefined,
		});
		if (!failedResult.ok) return failedResult;

		runtime.record = failedResult.value;
		runtime.lastPostReadyDisconnect = undefined;
		runtime.connectionOpen = false;
		runtime.trusted = false;
		return ok(cloneValue(runtime.record));
	}

	public sendSteer(agentId: string, message: string): ValidationOutcome<SidecarControlMessage<TData>> {
		return this.sendControl(agentId, "steer", { message });
	}

	public sendFollowUp(agentId: string, message: string): ValidationOutcome<SidecarControlMessage<TData>> {
		return this.sendControl(agentId, "follow_up", { message });
	}

	public sendInterrupt(agentId: string): ValidationOutcome<SidecarControlMessage<TData>> {
		return this.sendControl(agentId, "interrupt", {});
	}

	public sendPing(agentId: string): ValidationOutcome<SidecarControlMessage<TData>> {
		return this.sendControl(agentId, "ping", {});
	}

	public shutdownAll(): ValidationOutcome<ReadonlyArray<SubagentRecord<TData>>> {
		if (this.runtimes.size === 0) {
			return ok([]);
		}

		const stoppedRecords: SubagentRecord<TData>[] = [];
		let firstError: ValidationError | undefined;

		for (const runtime of this.runtimes.values()) {
			this.clearConnectingTimeout(runtime);
			if (runtime.record.state !== "stopped") {
				const stoppedResult = this.transitionRecord(runtime.record, "stopped", {
					stoppedAt: this.deriveTerminalTimestamp(runtime.record),
				});
				if (stoppedResult.ok) {
					runtime.record = stoppedResult.value;
					runtime.connectionOpen = false;
					runtime.trusted = false;
				} else if (!firstError) {
					firstError = stoppedResult;
				}
			} else {
				runtime.connectionOpen = false;
				runtime.trusted = false;
			}

			try {
				runtime.process.terminate("shutdown");
			} catch {
				// Best-effort shutdown.
			}

			try {
				runtime.sidecar.close();
			} catch {
				// Best-effort shutdown.
			}

			stoppedRecords.push(cloneValue(runtime.record));
		}

		if (firstError) {
			return firstError;
		}

		return ok(stoppedRecords);
	}

	private applyEvent(
		runtime: ManagedRuntime<TData>,
		event: SidecarEventMessage<TData>,
	): ValidationOutcome<SubagentRecord<TData>> {
		switch (event.type) {
			case "ready":
				return this.applyReady(runtime, event);
			case "progress":
				return this.applyProgress(runtime, event);
			case "needs_input":
				return this.applyNeedsInput(runtime, event);
			case "final_result":
				return this.applyFinalResult(runtime, event);
			case "user_intervened":
				return this.applyUserIntervened(runtime, event);
			case "state":
				return this.applyState(runtime, event);
			case "error":
				return this.applyError(runtime, event);
			case "pong":
				if (!runtime.trusted) {
					return fail("cannot accept pong before handshake is complete");
				}
				return ok(cloneValue(runtime.record));
		}
	}

	private applyReady(
		runtime: ManagedRuntime<TData>,
		event: Extract<SidecarEventMessage<TData>, { type: "ready" }>,
	): ValidationOutcome<SubagentRecord<TData>> {
		if (!runtime.lastHello) {
			return fail("cannot accept ready before hello has been sent");
		}
		if (runtime.trusted) {
			return fail("ready has already been accepted for this agent");
		}

		const handshakeResult = validateSidecarHandshake(runtime.lastHello, event, {
			agentId: runtime.launchSpec.agentId,
			sessionPath: runtime.launchSpec.sessionPath,
		});
		if (!handshakeResult.ok) return handshakeResult;

		const readyRecordResult = this.transitionRecord(runtime.record, "ready", {
			connectedAt: event.time,
		});
		if (!readyRecordResult.ok) return readyRecordResult;

		runtime.record = readyRecordResult.value;
		runtime.lastPostReadyDisconnect = undefined;
		this.clearConnectingTimeout(runtime);
		runtime.trusted = true;
		return ok(cloneValue(runtime.record));
	}

	private applyProgress(
		runtime: ManagedRuntime<TData>,
		event: Extract<SidecarEventMessage<TData>, { type: "progress" }>,
	): ValidationOutcome<SubagentRecord<TData>> {
		if (!runtime.trusted) {
			return fail("cannot accept progress before handshake is complete");
		}

		const reportResult = validateReportToParentInput<TData>(
			{
				kind: "progress",
				summary: event.payload.summary,
				data: event.payload.data,
			},
			runtime.record.state,
		);
		if (!reportResult.ok) return reportResult;
		const cloneableDataResult = ensureCloneable(reportResult.value.data ?? null, "progress.data");
		if (!cloneableDataResult.ok) return cloneableDataResult;

		const nextState: RuntimeState = "running";
		const nextRecord = {
			...runtime.record,
			state: nextState,
			error: undefined,
			lastProgressReport: this.makeReport(
				"progress",
				reportResult.value.summary,
				cloneableDataResult.value,
				event.time,
			),
			pendingInputRequest: undefined,
		};
		const normalizedResult = this.normalizeWithTransition(runtime.record, nextState, nextRecord);
		if (!normalizedResult.ok) return normalizedResult;
		runtime.record = normalizedResult.value;
		return ok(cloneValue(runtime.record));
	}

	private applyNeedsInput(
		runtime: ManagedRuntime<TData>,
		event: Extract<SidecarEventMessage<TData>, { type: "needs_input" }>,
	): ValidationOutcome<SubagentRecord<TData>> {
		if (!runtime.trusted) {
			return fail("cannot accept needs_input before handshake is complete");
		}

		const reportResult = validateReportToParentInput<TData>(
			{
				kind: "needs_input",
				summary: event.payload.question,
			},
			runtime.record.state,
		);
		if (!reportResult.ok) return reportResult;

		const nextState: RuntimeState = "needs_input";
		const nextRecord = {
			...runtime.record,
			state: nextState,
			error: undefined,
			pendingInputRequest: this.makeReport("needs_input", reportResult.value.summary, null, event.time),
		};
		const normalizedResult = this.normalizeWithTransition(runtime.record, nextState, nextRecord);
		if (!normalizedResult.ok) return normalizedResult;
		runtime.record = normalizedResult.value;
		return ok(cloneValue(runtime.record));
	}

	private applyFinalResult(
		runtime: ManagedRuntime<TData>,
		event: Extract<SidecarEventMessage<TData>, { type: "final_result" }>,
	): ValidationOutcome<SubagentRecord<TData>> {
		if (!runtime.trusted) {
			return fail("cannot accept final_result before handshake is complete");
		}

		const reportResult = validateReportToParentInput<TData>(
			{
				kind: "final_result",
				summary: event.payload.summary,
				data: event.payload.data,
			},
			runtime.record.state,
		);
		if (!reportResult.ok) return reportResult;
		const cloneableDataResult = ensureCloneable(reportResult.value.data ?? null, "final_result.data");
		if (!cloneableDataResult.ok) return cloneableDataResult;

		const nextHistory = [
			...(runtime.record.finalResultHistory ?? []),
			this.makeReport(
				"final_result",
				reportResult.value.summary,
				cloneableDataResult.value,
				event.time,
			),
		];
		const nextRecord = {
			...runtime.record,
			finalResult: nextHistory.at(-1),
			finalResultHistory: nextHistory,
		};
		const normalizedResult = normalizeRecord<TData>(nextRecord);
		if (!normalizedResult.ok) return normalizedResult;

		runtime.record = normalizedResult.value;
		return ok(cloneValue(runtime.record));
	}

	private applyUserIntervened(
		runtime: ManagedRuntime<TData>,
		event: Extract<SidecarEventMessage<TData>, { type: "user_intervened" }>,
	): ValidationOutcome<SubagentRecord<TData>> {
		if (!runtime.trusted) {
			return fail("cannot accept user_intervened before handshake is complete");
		}
		if (this.isDegraded(runtime.record)) {
			return fail("cannot accept user_intervened while agent is degraded");
		}

		const metadataResult = createUserIntervenedMetadata(event.time);
		if (!metadataResult.ok) return metadataResult;

		const nextRecord = {
			...runtime.record,
			userIntervenedHistory: [
				...(runtime.record.userIntervenedHistory ?? []),
				metadataResult.value as UserIntervenedMetadata,
			],
		};
		const normalizedResult = normalizeRecord<TData>(nextRecord);
		if (!normalizedResult.ok) return normalizedResult;

		runtime.record = normalizedResult.value;
		return ok(cloneValue(runtime.record));
	}

	private applyState(
		runtime: ManagedRuntime<TData>,
		event: Extract<SidecarEventMessage<TData>, { type: "state" }>,
	): ValidationOutcome<SubagentRecord<TData>> {
		if (!runtime.trusted) {
			return fail("cannot accept state before handshake is complete");
		}

		if (this.isTerminalReportedState(runtime.lastReportedState)) {
			return ok(cloneValue(runtime.record));
		}

		switch (event.payload.status) {
			case "starting":
				runtime.lastReportedState = event.payload.status;
				return ok(cloneValue(runtime.record));
			case "running":
			case "waiting":
			case "needs_input": {
				const nextState = event.payload.status;
				if (nextState === "needs_input" && runtime.record.pendingInputRequest === undefined) {
					runtime.lastReportedState = event.payload.status;
					return ok(cloneValue(runtime.record));
				}
				const nextRecord = {
					...runtime.record,
					state: nextState,
					error: undefined,
					pendingInputRequest: nextState === "needs_input" ? runtime.record.pendingInputRequest : undefined,
				};
				const normalizedResult = this.normalizeWithTransition(runtime.record, nextState, nextRecord);
				if (!normalizedResult.ok) return normalizedResult;

				runtime.record = normalizedResult.value;
				runtime.lastReportedState = event.payload.status;
				return ok(cloneValue(runtime.record));
			}
			case "failed": {
				const nextRecord = {
					...runtime.record,
					state: "failed" as const,
					error: {
						message: "child reported failed state",
						recordedAt: event.time,
						fatal: true,
					},
					pendingInputRequest: undefined,
				};
				const normalizedResult = this.normalizeWithTransition(runtime.record, "failed", nextRecord);
				if (!normalizedResult.ok) return normalizedResult;

				runtime.record = normalizedResult.value;
				runtime.lastReportedState = event.payload.status;
				return ok(cloneValue(runtime.record));
			}
			case "stopped": {
				const normalizedResult = this.transitionRecord(runtime.record, "stopped", {
					stoppedAt: event.time,
				});
				if (!normalizedResult.ok) return normalizedResult;

				runtime.record = normalizedResult.value;
				runtime.lastReportedState = event.payload.status;
				runtime.trusted = false;
				return ok(cloneValue(runtime.record));
			}
		}
	}

	private applyError(
		runtime: ManagedRuntime<TData>,
		event: Extract<SidecarEventMessage<TData>, { type: "error" }>,
	): ValidationOutcome<SubagentRecord<TData>> {
		if (!runtime.trusted) {
			return fail("cannot accept error before handshake is complete");
		}

		const nextRecord = {
			...runtime.record,
			state: "failed" as const,
			error: {
				message: event.payload.message,
				recordedAt: event.time,
				fatal: event.payload.fatal,
			},
			pendingInputRequest: undefined,
		};
		const normalizedResult = this.normalizeWithTransition(runtime.record, "failed", nextRecord);
		if (!normalizedResult.ok) return normalizedResult;

		runtime.record = normalizedResult.value;
		return ok(cloneValue(runtime.record));
	}

	private sendControl<TType extends ParentControlKind>(
		agentId: string,
		type: TType,
		payload: SidecarProtocolMessage<TData>["payload"] & Record<string, unknown>,
	): ValidationOutcome<SidecarControlMessage<TData>> {
		const runtimeResult = this.getRuntime(agentId);
		if (!runtimeResult.ok) return runtimeResult;
		const runtime = runtimeResult.value;

		if (!runtime.trusted) {
			return fail(`cannot send ${type} before handshake is complete`);
		}
		if (this.isDegraded(runtime.record)) {
			return fail(`cannot send ${type} while agent is degraded`);
		}
		if (this.isTerminal(runtime.record.state)) {
			return fail(`cannot send ${type} to terminal agent ${agentId}`);
		}

		const messageResult = this.buildControlMessage(runtime, type, payload);
		if (!messageResult.ok) return messageResult;

		try {
			runtime.sidecar.send(messageResult.value);
		} catch (error) {
			return fail(`failed to send ${type}: ${this.describeError(error)}`);
		}

		runtime.lastOutboundSeq = messageResult.value.seq;
		return ok(cloneValue(messageResult.value));
	}

	private buildControlMessage<TType extends ParentControlKind>(
		runtime: ManagedRuntime<TData>,
		type: TType,
		payload: Record<string, unknown>,
	): ValidationOutcome<SidecarControlMessage<TData>> {
		const seq = runtime.lastOutboundSeq === undefined ? 0 : runtime.lastOutboundSeq + 1;
		const messageResult = validateSidecarControlMessage<TData>({
			version: 1,
			agentId: runtime.launchSpec.agentId,
			type,
			seq,
			time: this.now(),
			payload,
		});
		if (!messageResult.ok) return messageResult;

		return ok(messageResult.value);
	}

	private transitionRecord(
		record: SubagentRecord<TData>,
		nextState: RuntimeState,
		extras: Record<string, unknown> = {},
	): ValidationOutcome<SubagentRecord<TData>> {
		const nextRecord = {
			...record,
			error: nextState === "failed" ? record.error : undefined,
			pendingInputRequest: nextState === "needs_input" ? record.pendingInputRequest : undefined,
			...extras,
			state: nextState,
		};
		return this.normalizeWithTransition(record, nextState, nextRecord);
	}

	private normalizeWithTransition(
		currentRecord: SubagentRecord<TData>,
		nextState: RuntimeState,
		candidate: Record<string, unknown>,
	): ValidationOutcome<SubagentRecord<TData>> {
		if (currentRecord.state !== nextState) {
			const transitionResult = assertRuntimeStateTransition(currentRecord.state, nextState);
			if (!transitionResult.ok) return transitionResult;
		}

		return normalizeRecord<TData>(candidate);
	}

	private makeReport<TKind extends "progress" | "needs_input" | "final_result">(
		kind: TKind,
		summary: string,
		data: TData | null,
		reportedAt: string,
	): ExplicitReport<TData> & { kind: TKind } {
		return {
			kind,
			summary,
			data,
			reportedAt,
		};
	}

	private getRuntime(agentId: string): ValidationOutcome<ManagedRuntime<TData>> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) {
			return fail(`unknown managed agent: ${agentId}`);
		}
		return ok(runtime);
	}

	private isTerminal(state: RuntimeState): boolean {
		return state === "stopped";
	}

	private isTerminalReportedState(state?: SidecarStateStatus): boolean {
		return state === "stopped";
	}

	private deriveAcceptedRecordTimestamp(record: SubagentRecord<TData>): string {
		let latest = record.createdAt;
		const candidates = [
			record.startedAt,
			record.connectedAt,
			record.stoppedAt,
			record.degradedAt,
			record.lastProgressReport?.reportedAt,
			record.pendingInputRequest?.reportedAt,
			record.finalResult?.reportedAt,
			record.finalResultHistory?.at(-1)?.reportedAt,
			record.userIntervenedHistory?.at(-1)?.recordedAt,
			record.error?.recordedAt,
		];
		for (const candidate of candidates) {
			if (candidate) {
				latest = maxIsoTimestamp(latest, candidate);
			}
		}

		return latest;
	}

	private deriveTerminalTimestamp(record: SubagentRecord<TData>): string {
		return maxIsoTimestamp(this.now(), this.deriveAcceptedRecordTimestamp(record));
	}

	private isDegraded(record: SubagentRecord<TData>): boolean {
		return Boolean(record.degradedAt);
	}

	private scheduleConnectingTimeout(agentId: string, runtime: ManagedRuntime<TData>): void {
		if (!Number.isFinite(this.connectingTimeoutMs) || this.connectingTimeoutMs <= 0) {
			return;
		}

		const handle = setTimeout(() => {
			this.failConnectingRuntime(agentId);
		}, this.connectingTimeoutMs);
		handle.unref?.();
		runtime.connectingTimeoutHandle = handle;
	}

	private clearConnectingTimeout(runtime: ManagedRuntime<TData>): void {
		if (runtime.connectingTimeoutHandle === undefined) {
			return;
		}

		clearTimeout(runtime.connectingTimeoutHandle);
		runtime.connectingTimeoutHandle = undefined;
	}

	private failConnectingRuntime(agentId: string): ValidationOutcome<SubagentRecord<TData>> {
		const runtimeResult = this.getRuntime(agentId);
		if (!runtimeResult.ok) return runtimeResult;
		const runtime = runtimeResult.value;
		this.clearConnectingTimeout(runtime);

		if (runtime.record.state !== "connecting" || this.isTerminal(runtime.record.state)) {
			return ok(cloneValue(runtime.record));
		}

		const failedResult = this.transitionRecord(runtime.record, "failed", {
			error: {
				message: "sidecar did not connect before timeout",
				recordedAt: this.deriveTerminalTimestamp(runtime.record),
				fatal: true,
			},
		});
		if (!failedResult.ok) return failedResult;

		runtime.record = failedResult.value;
		runtime.connectionOpen = false;
		runtime.trusted = false;
		try {
			runtime.process.terminate("shutdown");
		} catch {
			// Best-effort cleanup after connect timeout.
		}
		try {
			runtime.sidecar.close();
		} catch {
			// Best-effort cleanup after connect timeout.
		}
		return ok(cloneValue(runtime.record));
	}

	private describeError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
