import { spawn, type Subprocess } from "bun";
import {
  buildSafeStreamDestination,
  parseRdpConfig,
  parseStreamConfig,
  redactSecrets,
  type RdpConfig,
  type SessionState,
  type StreamConfig,
} from "@rdp-stream-studio/shared";
import { buildFfmpegArgs, buildFreeRdpArgs } from "./command-builder";

type ManagedProcess = {
  name: string;
  process: Subprocess;
  secrets: string[];
};

export class StudioProcessManager {
  private readonly display = process.env.DISPLAY_ID ?? ":99";
  private readonly pulseSource =
    process.env.PULSE_SOURCE ?? "rdp_stream.monitor";
  private readonly logs: string[] = [];
  private readonly processes = new Map<string, ManagedProcess>();
  private rdpConfig?: RdpConfig;
  private streamConfig?: StreamConfig;
  private rdpState: SessionState["rdp"] = "idle";
  private streamState: SessionState["stream"] = "idle";

  getState(): SessionState {
    return {
      rdp: this.rdpState,
      stream: this.streamState,
      safeDestination: this.streamState !== "idle" && this.streamConfig
        ? buildSafeStreamDestination(this.streamConfig)
        : undefined,
      logs: this.logs.slice(-200),
    };
  }

  async connect(input: unknown): Promise<SessionState> {
    const config = parseRdpConfig(input);
    this.rdpConfig = config;
    this.rdpState = "connecting";
    this.log("Starting virtual RDP session.");

    await this.stopProcess("xfreerdp");
    this.startProcess("xfreerdp", ["xfreerdp3", ...buildFreeRdpArgs(config)], [
      config.password,
    ]);
    this.rdpState = "connected";
    return this.getState();
  }

  async disconnect(): Promise<SessionState> {
    await this.stopStream();
    await this.stopProcess("xfreerdp");
    this.rdpState = "idle";
    this.log("RDP session stopped.");
    return this.getState();
  }

  async startStream(input: unknown, musicPath?: string): Promise<SessionState> {
    if (!this.rdpConfig) {
      throw new Error("Connect to an RDP session before starting the stream.");
    }

    const stream = parseStreamConfig(input);
    this.streamConfig = stream;
    this.streamState = "starting";
    await this.stopProcess("ffmpeg");

    const args = buildFfmpegArgs({
      display: this.display,
      pulseSource: this.pulseSource,
      musicPath,
      stream,
    });
    this.startProcess("ffmpeg", ["ffmpeg", ...args], [stream.streamKey]);
    this.streamState = "live";
    this.log(`Streaming to ${buildSafeStreamDestination(stream)}.`);
    return this.getState();
  }

  async stopStream(): Promise<SessionState> {
    await this.stopProcess("ffmpeg");
    this.streamState = "idle";
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
      this.log(`${name} exited with code ${code}.`);
      this.processes.delete(name);
      if (name === "xfreerdp" && this.rdpState !== "idle") {
        this.rdpState = code === 0 ? "idle" : "failed";
      }
      if (name === "ffmpeg" && this.streamState !== "idle") {
        this.streamState = code === 0 ? "idle" : "failed";
      }
    });
  }

  private async stopProcess(name: string): Promise<void> {
    const managed = this.processes.get(name);
    if (!managed) {
      return;
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
}
