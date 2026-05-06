import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";
import {
  parseMusicSource,
  type MusicSource,
} from "@rdp-stream-studio/shared";
import type { FfmpegMusicInput } from "./command-builder";

const youtubeCacheFolder = "youtube";
const youtubeAudioFormat = "bestaudio[ext=m4a]/bestaudio";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (cmd: string[]) => Promise<CommandResult>;
export type PathExists = (path: string) => Promise<boolean>;

export type ResolvedMusicInput = FfmpegMusicInput & {
  attribution?: string;
  secrets?: string[];
};

type YoutubeAudioMetadata = {
  id: string;
  ext: string;
  channel: string;
};

export async function resolveMusicSource(
  input: unknown,
  cacheDir: string,
  runCommand: CommandRunner = runLocalCommand,
  pathExists: PathExists = fileExists,
): Promise<ResolvedMusicInput | undefined> {
  const source = parseMusicSource(input);

  if (source.kind === "none") {
    return undefined;
  }

  if (source.kind === "uploaded") {
    return {
      input: source.path,
      loop: true,
      volume: source.volume,
    };
  }

  return resolveYoutubeMusicSource(source, cacheDir, runCommand, pathExists);
}

async function resolveYoutubeMusicSource(
  source: Extract<MusicSource, { kind: "url" }>,
  cacheDir: string,
  runCommand: CommandRunner,
  pathExists: PathExists,
): Promise<ResolvedMusicInput> {
  if (!isYoutubeUrl(source.url)) {
    throw new Error("Only YouTube URLs are supported for remote music beds.");
  }

  const youtubeCacheDir = join(cacheDir, youtubeCacheFolder);
  await mkdir(youtubeCacheDir, { recursive: true });

  const metadata = await loadYoutubeAudioMetadata(source.url, runCommand);
  const audioPath = join(
    youtubeCacheDir,
    `${safeFileSegment(metadata.id)}.${safeFileSegment(metadata.ext)}`,
  );

  if (!(await pathExists(audioPath))) {
    await downloadYoutubeAudio(source.url, youtubeCacheDir, metadata.id, runCommand);
  }

  if (!(await pathExists(audioPath))) {
    throw new Error("YouTube audio download completed but no cached audio file was found.");
  }

  return {
    input: audioPath,
    loop: true,
    volume: source.volume,
    attribution: buildAttribution(metadata.channel),
  };
}

async function loadYoutubeAudioMetadata(
  url: string,
  runCommand: CommandRunner,
): Promise<YoutubeAudioMetadata> {
  const result = await runCommand([
    ytDlpBinary(),
    "--no-playlist",
    "--no-warnings",
    "--js-runtimes",
    "node",
    "--remote-components",
    "ejs:github",
    "--skip-download",
    "--format",
    youtubeAudioFormat,
    "--print",
    "%(id)s",
    "--print",
    "%(ext)s",
    "--print",
    "%(channel)s",
    url,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(formatYtDlpError("Could not inspect YouTube music source", result));
  }

  const [id, ext, channel] = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!id || !ext) {
    throw new Error("Could not inspect YouTube music source: yt-dlp returned incomplete metadata.");
  }

  return { id, ext, channel: channel ?? "YouTube" };
}

async function downloadYoutubeAudio(
  url: string,
  cacheDir: string,
  id: string,
  runCommand: CommandRunner,
): Promise<void> {
  const result = await runCommand([
    ytDlpBinary(),
    "--no-playlist",
    "--no-warnings",
    "--js-runtimes",
    "node",
    "--remote-components",
    "ejs:github",
    "--format",
    youtubeAudioFormat,
    "--paths",
    cacheDir,
    "--output",
    `${safeFileSegment(id)}.%(ext)s`,
    url,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(formatYtDlpError("Could not download YouTube music source", result));
  }
}

function isYoutubeUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return (
      host === "youtube.com" ||
      host === "music.youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be"
    );
  } catch {
    return false;
  }
}

function buildAttribution(channel: string): string {
  if (channel.toLowerCase() === "lofi girl") {
    return "Music provided by Lofi Girl: https://www.youtube.com/@LofiGirl";
  }

  return `Music source: ${channel}`;
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function ytDlpBinary(): string {
  return process.env.YTDLP_BIN ?? "yt-dlp";
}

function formatYtDlpError(prefix: string, result: CommandResult): string {
  const details = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
  return `${prefix}: ${details}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runLocalCommand(cmd: string[]): Promise<CommandResult> {
  const [command, ...args] = cmd;
  if (!command) {
    throw new Error("Cannot run an empty command.");
  }

  const child = spawn({
    cmd: [command, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}
