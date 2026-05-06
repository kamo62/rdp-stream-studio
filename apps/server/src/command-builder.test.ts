import { describe, expect, test } from "bun:test";
import {
  buildFfmpegArgs,
  buildFreeRdpArgs,
  buildMusicInputArgs,
} from "./command-builder";

describe("command builders", () => {
  test("builds a fixed-size FreeRDP command for the virtual display", () => {
    const args = buildFreeRdpArgs({
      host: "20.1.2.3",
      port: 3389,
      username: "demo",
      password: "pass",
      domain: "AZURE",
      width: 1920,
      height: 1080,
      ignoreCertificate: true,
    });

    expect(args).toContain("/v:20.1.2.3:3389");
    expect(args).toContain("/u:demo");
    expect(args).toContain("/d:AZURE");
    expect(args).toContain("/size:1920x1080");
    expect(args).toContain("/gfx:AVC444:on,progressive:on");
    expect(args).toContain("/cert:ignore");
    expect(args).not.toContain("/dynamic-resolution");
  });

  test("builds ffmpeg args for a 1080p30 RTMPS stream", () => {
    const args = buildFfmpegArgs({
      display: ":99",
      pulseSource: "rdp_stream.monitor",
      musicInput: {
        input: "/data/music/theme.mp3",
        loop: true,
        volume: 0.3,
      },
      stream: {
        platform: "youtube",
        ingestUrl: "rtmps://a.rtmps.youtube.com/live2",
        streamKey: "secret",
        resolution: { width: 1920, height: 1080 },
        fps: 30,
        videoBitrateKbps: 6000,
        audioBitrateKbps: 128,
        keyframeSeconds: 2,
      },
    });

    expect(args).toContain("-f");
    expect(args).toContain("x11grab");
    expect(args).toContain("-video_size");
    expect(args).toContain("1920x1080");
    expect(args).toContain("-r");
    expect(args).toContain("30");
    expect(args).toContain("-g");
    expect(args).toContain("60");
    expect(args).toContain("-b:v");
    expect(args).toContain("6000k");
    expect(args).toContain("-maxrate");
    expect(args).toContain("-bufsize");
    expect(args).not.toContain("-vf");
    expect(args.at(-1)).toBe("rtmps://a.rtmps.youtube.com/live2/secret");
  });

  test("captures the full RDP display and scales for a lower stream profile", () => {
    const args = buildFfmpegArgs({
      display: ":99",
      pulseSource: "rdp_stream.monitor",
      captureResolution: { width: 1920, height: 1080 },
      stream: {
        platform: "youtube",
        ingestUrl: "rtmps://a.rtmps.youtube.com/live2",
        streamKey: "secret",
        resolution: { width: 1280, height: 720 },
        fps: 30,
        videoBitrateKbps: 3500,
        audioBitrateKbps: 128,
        keyframeSeconds: 2,
      },
    });

    expect(args).toContain("-video_size");
    expect(args).toContain("1920x1080");
    expect(args).toContain("-vf");
    expect(args).toContain("scale=1280:720:flags=fast_bilinear");
    expect(args).toContain("3500k");
  });

  test("supports optional music sources", () => {
    expect(buildMusicInputArgs()).toEqual([]);
    expect(
      buildMusicInputArgs({
        input: "/data/music/theme.mp3",
        loop: true,
        volume: 0.3,
      }),
    ).toEqual([
      "-stream_loop",
      "-1",
      "-i",
      "/data/music/theme.mp3",
    ]);
    expect(
      buildMusicInputArgs({
        input: "https://media.example.test/music.m4a",
        loop: true,
        remote: true,
        volume: 0.3,
      }),
    ).toEqual([
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "5",
      "-stream_loop",
      "-1",
      "-i",
      "https://media.example.test/music.m4a",
    ]);
  });

  test("applies music volume before mixing", () => {
    const args = buildFfmpegArgs({
      display: ":99",
      pulseSource: "rdp_stream.monitor",
      musicInput: {
        input: "/data/music/theme.mp3",
        loop: true,
        volume: 0.45,
      },
      stream: {
        platform: "youtube",
        ingestUrl: "rtmps://a.rtmps.youtube.com/live2",
        streamKey: "secret",
        resolution: { width: 1920, height: 1080 },
        fps: 30,
        videoBitrateKbps: 6000,
        audioBitrateKbps: 128,
        keyframeSeconds: 2,
      },
    });

    expect(args).toContain(
      "[2:a]volume=0.45[music];[1:a][music]amix=inputs=2:duration=first:dropout_transition=2[aout]",
    );
  });
});
