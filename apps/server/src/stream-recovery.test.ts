import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { MusicSource, RdpConfig, StreamConfig } from "@rdp-stream-studio/shared";
import {
  createStreamRecoveryRecord,
  loadStreamRecoveryRecord,
  saveStreamRecoveryRecord,
  toLastStreamSummary,
  updateStreamRecoveryStatus,
} from "./stream-recovery";

const stream: StreamConfig = {
  platform: "youtube",
  ingestUrl: "rtmp://a.rtmp.youtube.com/live2",
  streamKey: "secret-key",
  resolution: { width: 1920, height: 1080 },
  fps: 30,
  videoBitrateKbps: 6000,
  audioBitrateKbps: 128,
  keyframeSeconds: 2,
};

const musicSource: MusicSource = {
  kind: "url",
  url: "https://www.youtube.com/watch?v=CBSlu_VMS9U",
  volume: 0.3,
};

const rdp: RdpConfig = {
  host: "20.1.2.3",
  port: 3389,
  username: "kamo",
  password: "rdp-password",
  width: 1920,
  height: 1080,
  ignoreCertificate: true,
};

function withTempDir<T>(task: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "rdp-stream-recovery-"));
  try {
    return task(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("stream recovery records", () => {
  test("stores private restart details but exposes only a redacted summary", () => {
    withTempDir((dir) => {
      const record = createStreamRecoveryRecord({
        status: "active",
        stream,
        musicSource,
        rdp,
        now: new Date("2026-05-06T14:00:00.000Z"),
      });

      saveStreamRecoveryRecord(dir, record);

      const raw = readFileSync(join(dir, "last-stream.json"), "utf8");
      expect(raw).toContain("secret-key");
      expect(raw).toContain("rdp-password");
      expect(statSync(join(dir, "last-stream.json")).mode & 0o777).toBe(0o600);

      const loaded = loadStreamRecoveryRecord(dir);
      expect(loaded?.stream.streamKey).toBe("secret-key");
      expect(loaded?.rdp?.password).toBe("rdp-password");
      expect(loaded?.musicSource).toEqual(musicSource);

      const summary = toLastStreamSummary(loaded);
      expect(summary).toMatchObject({
        status: "active",
        safeDestination: "rtmp://a.rtmp.youtube.com/live2/********",
        platform: "youtube",
        ingestUrl: "rtmp://a.rtmp.youtube.com/live2",
        videoBitrateKbps: 6000,
        fps: 30,
        musicSourceKind: "url",
        canRestart: true,
        canAutoRestart: true,
      });
      expect(JSON.stringify(summary)).not.toContain("secret-key");
      expect(JSON.stringify(summary)).not.toContain("rdp-password");
    });
  });

  test("allows manual recovery but not auto restart without saved RDP details", () => {
    const record = createStreamRecoveryRecord({
      status: "interrupted",
      stream,
      musicSource,
      now: new Date("2026-05-06T14:00:00.000Z"),
    });

    expect(toLastStreamSummary(record)).toMatchObject({
      canRestart: true,
      canAutoRestart: false,
    });
  });

  test("hides records after an intentional user stop", () => {
    withTempDir((dir) => {
      const active = createStreamRecoveryRecord({
        status: "active",
        stream,
        musicSource,
        now: new Date("2026-05-06T14:00:00.000Z"),
      });
      saveStreamRecoveryRecord(dir, active);

      const stopped = updateStreamRecoveryStatus(active, {
        status: "stopped",
        reason: "User stopped the stream.",
        now: new Date("2026-05-06T14:05:00.000Z"),
      });
      saveStreamRecoveryRecord(dir, stopped);

      expect(toLastStreamSummary(loadStreamRecoveryRecord(dir))).toBeUndefined();
    });
  });
});
