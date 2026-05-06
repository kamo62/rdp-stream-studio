import {
  buildStreamDestination,
  type RdpConfig,
  type StreamConfig,
} from "@rdp-stream-studio/shared";

export type FfmpegCommandInput = {
  display: string;
  pulseSource: string;
  musicInput?: FfmpegMusicInput;
  captureResolution?: StreamConfig["resolution"];
  stream: StreamConfig;
};

export type FfmpegMusicInput = {
  input: string;
  loop: boolean;
  remote?: boolean;
  volume: number;
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

export function buildMusicInputArgs(musicInput?: FfmpegMusicInput): string[] {
  if (!musicInput) {
    return [];
  }

  return [
    ...(musicInput.remote
      ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
      : []),
    ...(musicInput.loop ? ["-stream_loop", "-1"] : []),
    "-i",
    musicInput.input,
  ];
}

export function buildFfmpegArgs(input: FfmpegCommandInput): string[] {
  const { stream } = input;
  const gopFrames = stream.fps * stream.keyframeSeconds;
  const captureResolution = input.captureResolution ?? stream.resolution;
  const shouldScale =
    captureResolution.width !== stream.resolution.width ||
    captureResolution.height !== stream.resolution.height;
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
    `${captureResolution.width}x${captureResolution.height}`,
    "-i",
    input.display,
    "-f",
    "pulse",
    "-i",
    input.pulseSource,
    ...buildMusicInputArgs(input.musicInput),
  ];

  const audioArgs = input.musicInput
    ? [
        "-filter_complex",
        `[2:a]volume=${input.musicInput.volume}[music];[1:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
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
    ...(shouldScale
      ? [
          "-vf",
          `scale=${stream.resolution.width}:${stream.resolution.height}:flags=fast_bilinear`,
        ]
      : []),
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
