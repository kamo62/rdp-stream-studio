import {
  buildStreamDestination,
  type RdpConfig,
  type StreamConfig,
} from "@rdp-stream-studio/shared";

export type FfmpegCommandInput = {
  display: string;
  pulseSource: string;
  musicPath?: string;
  stream: StreamConfig;
};

export function buildFreeRdpArgs(config: RdpConfig): string[] {
  const args = [
    `/v:${config.host}:${config.port}`,
    `/u:${config.username}`,
    `/p:${config.password}`,
    `/size:${config.width}x${config.height}`,
    "/gfx:AVC444:on,progressive:on",
    "/network:lan",
    "/sound:sys:pulse",
    "/microphone:sys:pulse",
  ];

  if (config.domain) {
    args.push(`/d:${config.domain}`);
  }

  if (config.ignoreCertificate) {
    args.push("/cert:ignore");
  }

  return args;
}

export function buildMusicInputArgs(musicPath?: string): string[] {
  if (!musicPath) {
    return [];
  }

  return ["-stream_loop", "-1", "-i", musicPath];
}

export function buildFfmpegArgs(input: FfmpegCommandInput): string[] {
  const { stream } = input;
  const gopFrames = stream.fps * stream.keyframeSeconds;
  const baseArgs = [
    "-hide_banner",
    "-loglevel",
    "info",
    "-f",
    "x11grab",
    "-draw_mouse",
    "1",
    "-r",
    String(stream.fps),
    "-video_size",
    `${stream.resolution.width}x${stream.resolution.height}`,
    "-i",
    input.display,
    "-f",
    "pulse",
    "-i",
    input.pulseSource,
    ...buildMusicInputArgs(input.musicPath),
  ];

  const audioArgs = input.musicPath
    ? [
        "-filter_complex",
        "[1:a][2:a]amix=inputs=2:duration=first:dropout_transition=2[aout]",
        "-map",
        "0:v",
        "-map",
        "[aout]",
      ]
    : ["-map", "0:v", "-map", "1:a"];

  return [
    ...baseArgs,
    ...audioArgs,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-b:v",
    `${stream.videoBitrateKbps}k`,
    "-maxrate",
    `${stream.videoBitrateKbps}k`,
    "-bufsize",
    `${stream.videoBitrateKbps * 2}k`,
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(gopFrames),
    "-keyint_min",
    String(gopFrames),
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-b:a",
    `${stream.audioBitrateKbps}k`,
    "-ar",
    "44100",
    "-f",
    "flv",
    buildStreamDestination(stream),
  ];
}
