import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { RdpConfig, StreamConfig } from "@rdp-stream-studio/shared";
import { StudioProcessManager } from "./process-manager";

const rdp: RdpConfig = {
  host: "20.1.2.3",
  port: 3389,
  username: "kamo",
  password: "rdp-password",
  width: 1920,
  height: 1080,
  ignoreCertificate: true,
};

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

function createFakeRuntime(): { dir: string; binDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "rdp-process-manager-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);

  const script = `#!/bin/sh
exit 0
`;
  for (const command of ["xfreerdp3", "ffmpeg"]) {
    const path = join(binDir, command);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }

  return { dir, binDir };
}

describe("StudioProcessManager", () => {
  test("serializes overlapping stream starts so only one ffmpeg process is launched", async () => {
    const runtime = createFakeRuntime();
    const oldPath = process.env.PATH;
    process.env.PATH = `${runtime.binDir}:${oldPath ?? ""}`;
    const manager = new StudioProcessManager({
      musicCacheDir: runtime.dir,
      autoRestartStream: false,
    });

    try {
      await manager.connect(rdp);
      await Promise.all([
        manager.startStream(stream, { kind: "none" }),
        manager.startStream(stream, { kind: "none" }),
      ]);

      expect(
        manager
          .getState()
          .logs.filter((line) => line.includes("Starting ffmpeg:")),
      ).toHaveLength(1);
    } finally {
      await manager.disconnect().catch(() => undefined);
      process.env.PATH = oldPath;
      rmSync(runtime.dir, { recursive: true, force: true });
    }
  });
});
