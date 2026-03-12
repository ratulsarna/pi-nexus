import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { SidecarControlMessage, RuntimeLaunchSpec } from "./contracts.js";
import type {
	ManagedProcessExit,
	SidecarSessionAdapter,
	SidecarSessionHandle,
	SidecarSessionHandlers,
	SubagentProcessAdapter,
	SubagentProcessHandle,
} from "./subagent-manager.js";

export interface NodeSidecarSessionAdapterOptions<TData = unknown> {
	onEnvelope?: (
		direction: "parent_to_child" | "child_to_parent",
		message: SidecarControlMessage<TData> | Record<string, unknown>,
	) => void;
}

function normalizeError(error: unknown): Error {
	if (error instanceof Error) {
		return error;
	}

	return new Error(String(error));
}

function cleanupSocketPath(socketPath: string): void {
	try {
		if (fs.existsSync(socketPath)) {
			fs.rmSync(socketPath, { force: true });
		}
	} catch {
		// Best-effort socket cleanup.
	}
}

class NodeSidecarSessionHandle<TData = unknown> implements SidecarSessionHandle<TData> {
	private socket: net.Socket | undefined;

	private readonly server: net.Server;

	private closed = false;

	private ownsSocketPath = false;

	private disconnected = false;

	private buffer = "";

	private lastDisconnectReason: string | undefined;

	public constructor(
		private readonly socketPath: string,
		private readonly handlers: SidecarSessionHandlers<TData>,
		private readonly options: NodeSidecarSessionAdapterOptions<TData>,
		) {
		this.server = net.createServer((socket) => {
			if (this.socket) {
				socket.destroy();
				return;
			}

			this.buffer = "";
			this.disconnected = false;
			this.lastDisconnectReason = undefined;
			this.socket = socket;
			socket.on("data", (chunk) => this.handleChunk(chunk));
			socket.on("error", (error) => {
				this.lastDisconnectReason = normalizeError(error).message;
			});
			socket.on("close", () => {
				this.buffer = "";
				this.socket = undefined;
				this.emitDisconnect(this.lastDisconnectReason);
			});
			const connectResult = this.handlers.onConnect();
			if (!connectResult.ok) {
				this.lastDisconnectReason = connectResult.error;
				socket.destroy(new Error(connectResult.error));
			}
		});
		this.server.on("listening", () => {
			this.ownsSocketPath = true;
		});
		this.server.on("close", () => {
			this.ownsSocketPath = false;
		});
		this.server.on("error", (error) => {
			this.lastDisconnectReason = normalizeError(error).message;
			this.emitDisconnect(this.lastDisconnectReason);
		});
		this.server.listen(this.socketPath);
	}

	public send(message: SidecarControlMessage<TData>): void {
		if (!this.socket) {
			throw new Error("sidecar socket is not connected");
		}

		this.socket.write(`${JSON.stringify(message)}\n`);
		this.options.onEnvelope?.("parent_to_child", message);
	}

	public close(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		this.buffer = "";
		this.lastDisconnectReason = undefined;
		const ownedSocketPath = this.ownsSocketPath;
		try {
			this.socket?.destroy();
		} catch {
			// Best-effort sidecar socket teardown.
		}
		this.socket = undefined;
		try {
			this.server.close();
		} catch {
			// Best-effort server close.
		}
		if (ownedSocketPath) {
			cleanupSocketPath(this.socketPath);
		}
		this.ownsSocketPath = false;
	}

	private handleChunk(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		while (true) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex < 0) {
				return;
			}

			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line.length === 0) {
				continue;
			}

			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(line) as Record<string, unknown>;
			} catch (error) {
				this.lastDisconnectReason = `invalid child message JSON: ${normalizeError(error).message}`;
				this.socket?.destroy(new Error(this.lastDisconnectReason));
				return;
			}

			this.options.onEnvelope?.("child_to_parent", parsed);
			const messageResult = this.handlers.onMessage(parsed);
			if (!messageResult.ok) {
				this.lastDisconnectReason = messageResult.error;
				this.socket?.destroy(new Error(messageResult.error));
				return;
			}
		}
	}

	private emitDisconnect(reason?: string): void {
		if (this.disconnected) {
			return;
		}

		this.disconnected = true;
		this.handlers.onDisconnect(reason);
	}
}

export class NodeSidecarSessionAdapter<TData = unknown> implements SidecarSessionAdapter<TData> {
	public constructor(private readonly options: NodeSidecarSessionAdapterOptions<TData> = {}) {}

	public openSession(socketPath: string, handlers: SidecarSessionHandlers<TData>): SidecarSessionHandle<TData> {
		return new NodeSidecarSessionHandle(socketPath, handlers, this.options);
	}
}

export class ChildProcessSubagentProcessAdapter implements SubagentProcessAdapter {
	public launch(
		launchSpec: RuntimeLaunchSpec,
		handlers: { onExit: (exit: ManagedProcessExit) => void },
	): SubagentProcessHandle {
		const child = spawn(launchSpec.command, launchSpec.args, {
			cwd: launchSpec.cwd,
			env: launchSpec.env,
			stdio: "ignore",
		});
		child.once("exit", (code, signal) => {
			handlers.onExit({ code, signal });
		});
		child.once("error", () => {
			handlers.onExit({ code: null, signal: "SPAWN_ERROR" });
		});

		return {
			terminate(reason) {
				child.kill(reason === "abort" ? "SIGINT" : "SIGTERM");
			},
		};
	}
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function joinShellWords(words: ReadonlyArray<string>): string {
	return words.map((word) => shQuote(word)).join(" ");
}

function validateTmuxLaunchEnvEntry(key: string, value: string): void {
	if (key.length === 0) {
		throw new Error("launch env keys must be non-empty");
	}
	if (key.includes("=")) {
		throw new Error(`launch env key must not contain =: ${key}`);
	}
	if (key.includes("\0")) {
		throw new Error(`launch env key must not contain NUL: ${key}`);
	}
	if (value.includes("\0")) {
		throw new Error(`launch env value must not contain NUL: ${key}`);
	}
}

function buildTmuxEnvCommand(env: Readonly<Record<string, string>>): string {
	const envAssignments = Object.entries(env).map(([key, value]) => {
		validateTmuxLaunchEnvEntry(key, value);
		return shQuote(`${key}=${value}`);
	});
	return envAssignments.length > 0 ? `env -i ${envAssignments.join(" ")}` : "env -i";
}

function createTmuxLaunchArtifacts(exitMarkerDir: string): {
	launchDir: string;
	launcherPath: string;
	exitMarkerPath: string;
} {
	const launchDir = fs.mkdtempSync(path.join(exitMarkerDir, "tmux-launch-"));
	return {
		launchDir,
		launcherPath: path.join(launchDir, "launch.sh"),
		exitMarkerPath: path.join(launchDir, "exit.code"),
	};
}

function cleanupTmuxLaunchArtifacts(launchDir: string): void {
	try {
		fs.rmSync(launchDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup for tmux launch artifacts.
	}
}

function writeTmuxLaunchScript(
	launchSpec: RuntimeLaunchSpec,
	launcherPath: string,
	exitMarkerPath: string,
): string {
	const command = joinShellWords([launchSpec.command, ...launchSpec.args]);
	const envCommand = buildTmuxEnvCommand(launchSpec.env);
	const script = `#!/bin/sh
cd ${shQuote(launchSpec.cwd)} || exit 1
${envCommand} ${command}
status=$?
printf '%s\n' "$status" > ${shQuote(exitMarkerPath)}
exit "$status"
`;
	fs.writeFileSync(launcherPath, script, { mode: 0o755 });
	return launcherPath;
}

function runTmuxCommand(args: string[]): void {
	const result = spawnSync("tmux", args, { stdio: "ignore" });
	if (result.status !== 0) {
		throw new Error(`tmux command failed: tmux ${args.join(" ")}`);
	}
}

export class TmuxSubagentProcessAdapter implements SubagentProcessAdapter {
	public constructor(
		private readonly options: {
			pollIntervalMs?: number;
			exitMarkerDir?: string;
		} = {},
	) {}

	public launch(
		launchSpec: RuntimeLaunchSpec,
		handlers: { onExit: (exit: ManagedProcessExit) => void },
	): SubagentProcessHandle {
		const exitMarkerDir = this.options.exitMarkerDir ?? path.dirname(launchSpec.sessionPath);
		fs.mkdirSync(exitMarkerDir, { recursive: true });
		const { launchDir, launcherPath, exitMarkerPath } = createTmuxLaunchArtifacts(exitMarkerDir);
		try {
			writeTmuxLaunchScript(launchSpec, launcherPath, exitMarkerPath);
			runTmuxCommand(["send-keys", "-t", launchSpec.tmuxTarget, "-l", `sh ${shQuote(launcherPath)}`]);
			runTmuxCommand(["send-keys", "-t", launchSpec.tmuxTarget, "Enter"]);
		} catch (error) {
			cleanupTmuxLaunchArtifacts(launchDir);
			throw error;
		}

		let exited = false;
		const finalizeExit = (exit: ManagedProcessExit): void => {
			exited = true;
			clearInterval(interval);
			cleanupTmuxLaunchArtifacts(launchDir);
			handlers.onExit(exit);
		};
		const interval = setInterval(() => {
			if (exited || !fs.existsSync(exitMarkerPath)) {
				return;
			}

			const rawExitCode = fs.readFileSync(exitMarkerPath, "utf8").trim();
			const parsedExitCode = Number(rawExitCode);
			finalizeExit({
				code: Number.isSafeInteger(parsedExitCode) ? parsedExitCode : null,
				signal: null,
			});
		}, this.options.pollIntervalMs ?? 100);
		interval.unref?.();

		return {
			terminate(reason) {
				if (exited) {
					return;
				}

				let terminateError: Error | undefined;
				try {
					runTmuxCommand([
						launchSpec.tmuxMode === "pane" ? "kill-pane" : "kill-window",
						"-t",
						launchSpec.tmuxTarget,
					]);
				} catch (error) {
					terminateError = normalizeError(error);
				} finally {
					finalizeExit({
						code: null,
						signal: reason === "abort" ? "SIGINT" : "SIGTERM",
					});
				}
				if (terminateError) {
					throw terminateError;
				}
			},
		};
	}
}
