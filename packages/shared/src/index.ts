import { z } from "zod";

export const ResolutionSchema = z.object({
  width: z.number().int().min(640).max(3840).default(1920),
  height: z.number().int().min(360).max(2160).default(1080),
});

export const RdpConfigSchema = z.object({
  host: z.string().trim().min(1, "host is required"),
  port: z.number().int().min(1).max(65535).default(3389),
  username: z.string().trim().min(1, "username is required"),
  password: z.string().min(1, "password is required"),
  domain: z.string().trim().optional(),
  width: z.number().int().min(640, "width must be at least 640").default(1920),
  height: z.number().int().min(360, "height must be at least 360").default(1080),
  ignoreCertificate: z.boolean().default(true),
});

export const StreamConfigSchema = z.object({
  platform: z.enum(["youtube", "twitch", "generic"]).default("youtube"),
  ingestUrl: z.string().trim().url("ingestUrl must be a valid RTMP/RTMPS URL"),
  streamKey: z.string().trim().min(1, "streamKey is required"),
  resolution: ResolutionSchema.default({ width: 1920, height: 1080 }),
  fps: z.number().int().min(15).max(60).default(30),
  videoBitrateKbps: z.number().int().min(1000).max(51000).default(6000),
  audioBitrateKbps: z.number().int().min(64).max(384).default(128),
  keyframeSeconds: z.number().int().min(1).max(4).default(2),
});

export const MusicSourceSchema = z.object({
  kind: z.enum(["none", "uploaded", "url"]).default("none"),
  path: z.string().trim().optional(),
  url: z.string().trim().url().optional(),
  volume: z.number().min(0).max(1).default(0.3),
});

export const SessionStateSchema = z.object({
  rdp: z.enum(["idle", "connecting", "connected", "failed"]).default("idle"),
  stream: z.enum(["idle", "starting", "live", "failed"]).default("idle"),
  safeDestination: z.string().optional(),
  logs: z.array(z.string()).default([]),
});

export type RdpConfig = z.infer<typeof RdpConfigSchema>;
export type StreamConfig = z.infer<typeof StreamConfigSchema>;
export type MusicSource = z.infer<typeof MusicSourceSchema>;
export type SessionState = z.infer<typeof SessionStateSchema>;

export function parseRdpConfig(input: unknown): RdpConfig {
  return RdpConfigSchema.parse(input);
}

export function parseStreamConfig(input: unknown): StreamConfig {
  return StreamConfigSchema.parse(input);
}

export function parseMusicSource(input: unknown): MusicSource {
  return MusicSourceSchema.parse(input);
}

export function buildStreamDestination(stream: StreamConfig): string {
  const base = stream.ingestUrl.replace(/\/+$/, "");
  return `${base}/${stream.streamKey}`;
}

export function buildSafeStreamDestination(stream: StreamConfig): string {
  const base = stream.ingestUrl.replace(/\/+$/, "");
  return `${base}/********`;
}

export function redactSecrets(message: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (safeMessage, secret) => safeMessage.split(secret).join("********"),
      message,
    );
}
