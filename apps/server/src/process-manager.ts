import { spawn, type Subprocess } from "bun";
import {
  buildSafeStreamDestination,
  parseRdpConfig,
  parseMusicSource,
  parseStreamConfig,
  redactSecrets,
  type MusicSource,
  type RdpConfig,
  type SessionState,
  type StreamConfig,
} from "@rdp-stream-studio/shared";
import { buildFfmpegArgs, buildFreeRdpArgs } from "./command-builder";
import { resolveMusicSource } from "./music-source";
import {
  createStreamRecoveryRecord,
  loadStreamRecoveryRecord,
  saveStreamRecoveryRecord,
  toLastStreamSummary,
  updateStreamRecoveryStatus,
  type StreamRecoveryRecord,
  type StreamRecoveryStatus,
} from "./stream-recovery";

type ManagedProcess = {
  name: string;
  process: Subprocess;
  secrets: string[];
  intentionalStop?: boolean;
};

type StudioProcessManagerOptions = {
  musicCacheDir?: string;
  autoRestartStream?: boolean;
  autoRestartMaxAttempts?: number;
  autoRestartInitialDelayMs?: number;
  autoRestartMaxDelayMs?: number;
  autoRestartStartupDelayMs?: number;
  autoRestartRdpWarmupMs?: number;
  autoRestartStableAfterMs?: number;
};

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function readNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StudioProcessManager {
  private readonly display = process.env.DISPLAY_ID ?? ":99";
  private readonly pulseSource =
    process.env.PULSE_SOURCE ?? "rdp_stream.monitor";
  private readonly musicCacheDir: string;
  private readonly autoRestartStream: boolean;
  private readonly autoRestartMaxAttempts: number;
  private readonly autoRestartInitialDelayMs: number;
  private readonly autoRestartMaxDelayMs: number;
  private readonly autoRestartStartupDelayMs: number;
  private readonly autoRestartRdpWarmupMs: number;
  private readonly autoRestartStableAfterMs: number;
  private readonly logs: string[] = [];
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly intentionallyStoppedProcesses = new WeakSet<Subprocess>();
  private autoRestartTimer?: ReturnType<typeof setTimeout>;
  private streamStableTimer?: ReturnType<typeof setTimeout>;
  private streamStartPromise?: Promise<SessionState>;
  private autoRestartAttempts = 0;
  private rdpConfig?: RdpConfig;
  private streamConfig?: StreamConfig;
  private lastStreamRecord?: StreamRecoveryRecord;
  private rdpState: SessionState["rdp"] = "idle";
  private streamState: SessionState["stream"] = "idle";

  constructor(options: StudioProcessManagerOptions = {}) {
    this.musicCacheDir =
      options.musicCacheDir ??
      process.env.MUSIC_UPLOAD_DIR ??
      "/tmp/rdp-stream-studio";
    this.autoRestartStream =
      options.autoRestartStream ??
      readBooleanEnv("AUTO_RESTART_STREAM", true);
    this.autoRestartMaxAttempts =
      options.autoRestartMaxAttempts ??
      readNumberEnv("AUTO_RESTART_MAX_ATTEMPTS", 12);
    this.autoRestartInitialDelayMs =
      options.autoRestartInitialDelayMs ??
      readNumberEnv("AUTO_RESTART_INITIAL_DELAY_MS", 5_000);
    this.autoRestartMaxDelayMs =
      options.autoRestartMaxDelayMs ??
      readNumberEnv("AUTO_RESTART_MAX_DELAY_MS", 60_000);
    this.autoRestartStartupDelayMs =
      options.autoRestartStartupDelayMs ??
      readNumberEnv("AUTO_RESTART_STARTUP_DELAY_MS", 15_000);
    this.autoRestartRdpWarmupMs =
      options.autoRestartRdpWarmupMs ??
      readNumberEnv("AUTO_RESTART_RDP_WARMUP_MS", 8_000);
    this.autoRestartStableAfterMs =
      options.autoRestartStableAfterMs ??
      readNumberEnv("AUTO_RESTART_STABLE_AFTER_MS", 60_000);
    this.lastStreamRecord = loadStreamRecoveryRecord(this.musicCacheDir);
    if (this.lastStreamRecord?.status === "active") {
      this.updateLastStreamRecord("interrupted", "App restarted while stream was active.");
      if (this.lastStreamRecord) {
        this.log(
          `Recovered interrupted stream details for ${this.lastStreamRecord.safeDestination}.`,
        );
      }
      this.scheduleAutoRestart("App restarted while stream was active.", {
        delayMs: this.autoRestartStartupDelayMs,
      });
    }
  }

  getState(): SessionState {
    return {
      rdp: this.rdpState,
      stream: this.streamState,
      safeDestination: this.streamState !== "idle" && this.streamConfig
        ? buildSafeStreamDestination(this.streamConfig)
        : undefined,
      lastStream: toLastStreamSummary(this.lastStreamRecord),
      logs: this.logs.slice(-200),
    };
  }

  async connect(input: unknown): Promise<SessionState> {
    const config = parseRdpConfig(input);
    this.resetAutoRestartBudget();
    this.clearStreamStableTimer();
    this.rdpConfig = config;
    this.rdpState = "connecting";
    if (this.streamState === "failed") {
      this.streamState = "idle";
    }
    this.log("Starting virtual RDP session.");

    await this.stopProcess("xfreerdp", { intentional: true });
    this.startProcess("xfreerdp", ["xfreerdp3", ...buildFreeRdpArgs(config)], [
      config.password,
    ]);
    this.rdpState = "connected";
    return this.getState();
  }

  async disconnect(): Promise<SessionState> {
    this.clearAutoRestartTimer();
    await this.stopStream();
    await this.stopProcess("xfreerdp", { intentional: true });
    this.rdpState = "idle";
    this.log("RDP session stopped.");
    return this.getState();
  }

  async startStream(
    input: unknown,
    musicSource?: unknown,
    options: { autoRestart?: boolean } = {},
  ): Promise<SessionState> {
    if (this.streamStartPromise) {
      this.log("Stream start already in progress; joining existing start.");
      return this.streamStartPromise;
    }

    const startPromise = this.startStreamNow(input, musicSource, options);
    this.streamStartPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.streamStartPromise === startPromise) {
        this.streamStartPromise = undefined;
      }
    }
  }

  private async startStreamNow(
    input: unknown,
    musicSource?: unknown,
    options: { autoRestart?: boolean } = {},
  ): Promise<SessionState> {
    if (!this.rdpConfig) {
      throw new Error("Connect to an RDP session before starting the stream.");
    }

    if (!options.autoRestart) {
      this.clearAutoRestartTimer();
      this.autoRestartAttempts = 0;
    }
    this.clearStreamStableTimer();

    const stream = parseStreamConfig(input);
    const parsedMusicSource = parseMusicSource(musicSource);
    const musicInput = await resolveMusicSource(
      parsedMusicSource,
      this.musicCacheDir,
    );
    this.streamConfig = stream;
    this.streamState = "starting";
    await this.stopProcess("ffmpeg", { intentional: true });
    this.rememberStream("active", stream, parsedMusicSource, this.rdpConfig);

    const args = buildFfmpegArgs({
      display: this.display,
      pulseSource: this.pulseSource,
      musicInput,
      captureResolution: {
        width: this.rdpConfig.width,
        height: this.rdpConfig.height,
      },
      stream,
    });
    this.startProcess("ffmpeg", ["ffmpeg", ...args], [
      stream.streamKey,
      ...(musicInput?.secrets ?? []),
    ]);
    this.streamState = "live";
    this.scheduleStreamStableReset();
    this.log(`Streaming to ${buildSafeStreamDestination(stream)}.`);
    if (musicInput?.attribution) {
      this.log(musicInput.attribution);
    }
    return this.getState();
  }

  async restartLastStream(
    options: { autoRestart?: boolean } = {},
  ): Promise<SessionState> {
    if (!this.lastStreamRecord || this.lastStreamRecord.status === "stopped") {
      throw new Error("No saved stream details are available to restart.");
    }

    if (!options.autoRestart) {
      this.resetAutoRestartBudget();
      this.clearStreamStableTimer();
    }

    if (this.rdpState !== "connected") {
      const rdp = this.lastStreamRecord.rdp ?? this.rdpConfig;
      if (!rdp) {
        throw new Error("Saved stream cannot restart automatically without saved RDP details.");
      }

      this.rdpConfig = rdp;
      this.rdpState = "connecting";
      this.log(`Reconnecting saved RDP session ${rdp.host}:${rdp.port}.`);
      await this.stopProcess("xfreerdp", { intentional: true });
      this.startProcess("xfreerdp", ["xfreerdp3", ...buildFreeRdpArgs(rdp)], [
        rdp.password,
      ]);
      this.rdpState = "connected";
      await delay(this.autoRestartRdpWarmupMs);
      if (this.rdpState !== "connected") {
        throw new Error("Saved RDP session failed to reconnect.");
      }
    }

    this.log(`Restarting saved stream ${this.lastStreamRecord.safeDestination}.`);
    return this.startStream(
      this.lastStreamRecord.stream,
      this.lastStreamRecord.musicSource,
      options,
    );
  }

  async stopStream(): Promise<SessionState> {
    this.clearAutoRestartTimer();
    this.clearStreamStableTimer();
    const hadSavedStream = Boolean(
      this.lastStreamRecord && this.lastStreamRecord.status !== "stopped",
    );
    await this.stopProcess("ffmpeg", { intentional: true });
    this.streamState = "idle";
    if (hadSavedStream) {
      this.updateLastStreamRecord("stopped", "User stopped the stream.");
    }
    this.log("Stream stopped.");
    return this.getState();
  }

  appendLog(message: string): void {
    this.log(message);
  }

  private startProcess(name: string, command: string[], secrets: string[]): void {
    const [cmd, ...args] = command;
    if (!cmd) {
      throw new Error("Cannot start an empty command.");
    }

    this.log(`Starting ${name}: ${redactSecrets(command.join(" "), secrets)}`);
    const child = spawn({
      cmd: [cmd, ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DISPLAY: this.display,
        PULSE_SERVER: process.env.PULSE_SERVER ?? "unix:/tmp/pulse/native",
      },
    });

    this.processes.set(name, { name, process: child, secrets });
    this.captureOutput(name, child.stdout, secrets);
    this.captureOutput(name, child.stderr, secrets);

    void child.exited.then((code) => {
      const managed = this.processes.get(name);
      if (managed?.process !== child) {
        this.log(`${name} exited with code ${code} for a stale process.`);
        return;
      }
      const intentionalStop =
        managed.intentionalStop ?? this.intentionallyStoppedProcesses.has(child);
      this.log(`${name} exited with code ${code}.`);
      this.processes.delete(name);
      if (name === "xfreerdp" && this.rdpState !== "idle") {
        this.rdpState = code === 0 ? "idle" : "failed";
        if (!intentionalStop && this.streamState !== "idle") {
          this.handleUnexpectedRdpExit(code);
        }
      }
      if (name === "ffmpeg" && this.streamState !== "idle" && !intentionalStop) {
        this.handleUnexpectedFfmpegExit(code);
      }
    });
  }

  private async stopProcess(
    name: string,
    options: { intentional?: boolean } = {},
  ): Promise<void> {
    const managed = this.processes.get(name);
    if (!managed) {
      return;
    }

    managed.intentionalStop = options.intentional ?? false;
    if (managed.intentionalStop) {
      this.intentionallyStoppedProcesses.add(managed.process);
    }
    managed.process.kill();
    await managed.process.exited.catch(() => undefined);
    this.processes.delete(name);
  }

  private captureOutput(
    name: string,
    stream: ReadableStream<Uint8Array>,
    secrets: string[],
  ): void {
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        this.log(`${name}: ${redactSecrets(decoder.decode(value), secrets)}`);
      }
    })();
  }

  private log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message.trim()}`;
    this.logs.push(line);
    if (this.logs.length > 500) {
      this.logs.shift();
    }
  }

  private rememberStream(
    status: StreamRecoveryStatus,
    stream: StreamConfig,
    musicSource: MusicSource,
    rdp: RdpConfig,
  ): void {
    this.lastStreamRecord = createStreamRecoveryRecord({
      status,
      stream,
      musicSource,
      rdp,
    });
    this.saveLastStreamRecord();
  }

  private updateLastStreamRecord(
    status: StreamRecoveryStatus,
    reason: string,
  ): void {
    if (!this.lastStreamRecord) {
      return;
    }

    this.lastStreamRecord = updateStreamRecoveryStatus(this.lastStreamRecord, {
      status,
      reason,
    });
    this.saveLastStreamRecord();
  }

  private saveLastStreamRecord(): void {
    if (!this.lastStreamRecord) {
      return;
    }

    try {
      saveStreamRecoveryRecord(this.musicCacheDir, this.lastStreamRecord);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      this.log(`Failed to save stream recovery details: ${message}`);
    }
  }

  private handleUnexpectedFfmpegExit(code: number | null): void {
    this.clearStreamStableTimer();
    this.streamState = "failed";
    const reason = `ffmpeg exited unexpectedly with code ${code}.`;
    this.updateLastStreamRecord("interrupted", reason);
    if (this.lastStreamRecord) {
      this.log(
        `Saved interrupted stream details for ${this.lastStreamRecord.safeDestination}.`,
      );
    }
    this.scheduleAutoRestart(reason);
  }

  private handleUnexpectedRdpExit(code: number | null): void {
    this.clearStreamStableTimer();
    const reason = `RDP exited unexpectedly with code ${code}.`;
    this.streamState = "failed";
    this.updateLastStreamRecord("interrupted", reason);
    this.log("Stopping stream because the RDP session disconnected.");
    void this.stopProcess("ffmpeg", { intentional: true });
    this.scheduleAutoRestart(reason);
  }

  private scheduleAutoRestart(
    reason: string,
    options: { delayMs?: number } = {},
  ): void {
    if (!this.autoRestartStream) {
      this.log("Auto-restart skipped because AUTO_RESTART_STREAM is disabled.");
      return;
    }
    if (!this.lastStreamRecord || this.lastStreamRecord.status === "stopped") {
      return;
    }
    if (!this.lastStreamRecord.rdp && !this.rdpConfig) {
      this.log("Auto-restart skipped because no saved RDP details are available.");
      return;
    }
    if (this.autoRestartTimer) {
      return;
    }
    if (this.autoRestartAttempts >= this.autoRestartMaxAttempts) {
      this.log(
        `Auto-restart gave up after ${this.autoRestartMaxAttempts} attempts.`,
      );
      return;
    }

    this.autoRestartAttempts += 1;
    const retryDelay =
      options.delayMs ??
      Math.min(
        this.autoRestartInitialDelayMs * 2 ** (this.autoRestartAttempts - 1),
        this.autoRestartMaxDelayMs,
      );
    this.log(
      `Auto-restart scheduled in ${Math.round(retryDelay / 1000)}s after ${reason} ` +
        `(attempt ${this.autoRestartAttempts}/${this.autoRestartMaxAttempts}).`,
    );
    this.autoRestartTimer = setTimeout(() => {
      this.autoRestartTimer = undefined;
      void this.performAutoRestart();
    }, retryDelay);
  }

  private async performAutoRestart(): Promise<void> {
    if (!this.lastStreamRecord || this.lastStreamRecord.status === "stopped") {
      return;
    }

    try {
      this.log("Auto-restart attempting saved stream.");
      await this.restartLastStream({ autoRestart: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      this.streamState = "failed";
      this.updateLastStreamRecord("interrupted", `Auto-restart failed: ${message}`);
      this.log(`Auto-restart failed: ${message}`);
      this.scheduleAutoRestart(message);
    }
  }

  private scheduleStreamStableReset(): void {
    this.clearStreamStableTimer();
    if (this.autoRestartStableAfterMs === 0) {
      return;
    }

    this.streamStableTimer = setTimeout(() => {
      if (this.streamState === "live") {
        this.autoRestartAttempts = 0;
        this.log("Stream stayed live; auto-restart retry budget reset.");
      }
      this.streamStableTimer = undefined;
    }, this.autoRestartStableAfterMs);
  }

  private clearAutoRestartTimer(): void {
    if (this.autoRestartTimer) {
      clearTimeout(this.autoRestartTimer);
      this.autoRestartTimer = undefined;
    }
  }

  private resetAutoRestartBudget(): void {
    this.clearAutoRestartTimer();
    this.autoRestartAttempts = 0;
  }

  private clearStreamStableTimer(): void {
    if (this.streamStableTimer) {
      clearTimeout(this.streamStableTimer);
      this.streamStableTimer = undefined;
    }
  }
}
