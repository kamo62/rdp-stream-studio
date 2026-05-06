import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  buildSafeStreamDestination,
  MusicSourceSchema,
  RdpConfigSchema,
  StreamConfigSchema,
  type LastStreamSummary,
  type MusicSource,
  type RdpConfig,
  type StreamConfig,
} from "@rdp-stream-studio/shared";

const recoveryFileName = "last-stream.json";

const StreamRecoveryStatusSchema = z.enum(["active", "interrupted", "stopped"]);

const StreamRecoveryRecordSchema = z.object({
  version: z.literal(1),
  status: StreamRecoveryStatusSchema,
  updatedAt: z.string(),
  reason: z.string().optional(),
  safeDestination: z.string(),
  stream: StreamConfigSchema,
  musicSource: MusicSourceSchema,
  rdp: RdpConfigSchema.optional(),
});

export type StreamRecoveryStatus = z.infer<typeof StreamRecoveryStatusSchema>;
export type StreamRecoveryRecord = z.infer<typeof StreamRecoveryRecordSchema>;

export function streamRecoveryPath(dataDir: string): string {
  return join(dataDir, recoveryFileName);
}

export function createStreamRecoveryRecord(input: {
  status: StreamRecoveryStatus;
  stream: StreamConfig;
  musicSource?: MusicSource;
  rdp?: RdpConfig;
  reason?: string;
  now?: Date;
}): StreamRecoveryRecord {
  return {
    version: 1,
    status: input.status,
    updatedAt: (input.now ?? new Date()).toISOString(),
    reason: input.reason,
    safeDestination: buildSafeStreamDestination(input.stream),
    stream: input.stream,
    musicSource: input.musicSource ?? { kind: "none", volume: 0.3 },
    rdp: input.rdp,
  };
}

export function updateStreamRecoveryStatus(
  record: StreamRecoveryRecord,
  input: {
    status: StreamRecoveryStatus;
    reason?: string;
    now?: Date;
  },
): StreamRecoveryRecord {
  return {
    ...record,
    status: input.status,
    updatedAt: (input.now ?? new Date()).toISOString(),
    reason: input.reason,
  };
}

export function saveStreamRecoveryRecord(
  dataDir: string,
  record: StreamRecoveryRecord,
): void {
  mkdirSync(dataDir, { recursive: true });

  const path = streamRecoveryPath(dataDir);
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, path);
  chmodSync(path, 0o600);
}

export function loadStreamRecoveryRecord(
  dataDir: string,
): StreamRecoveryRecord | undefined {
  try {
    return StreamRecoveryRecordSchema.parse(
      JSON.parse(readFileSync(streamRecoveryPath(dataDir), "utf8")),
    );
  } catch {
    return undefined;
  }
}

export function toLastStreamSummary(
  record?: StreamRecoveryRecord,
): LastStreamSummary | undefined {
  if (!record || record.status === "stopped") {
    return undefined;
  }

  return {
    status: record.status,
    safeDestination: record.safeDestination,
    platform: record.stream.platform,
    ingestUrl: record.stream.ingestUrl,
    resolution: record.stream.resolution,
    fps: record.stream.fps,
    videoBitrateKbps: record.stream.videoBitrateKbps,
    audioBitrateKbps: record.stream.audioBitrateKbps,
    keyframeSeconds: record.stream.keyframeSeconds,
    musicSourceKind: record.musicSource.kind,
    updatedAt: record.updatedAt,
    reason: record.reason,
    canRestart: true,
    canAutoRestart: Boolean(record.rdp),
  };
}
