import { describe, expect, test } from "bun:test";
import {
  buildSafeStreamDestination,
  parseMusicSource,
  parseRdpConfig,
  parseStreamConfig,
  redactSecrets,
} from "./index";

describe("shared config schemas", () => {
  test("normalizes the default 1080p30 stable profile", () => {
    const parsed = parseStreamConfig({
      platform: "youtube",
      ingestUrl: "rtmps://a.rtmps.youtube.com/live2",
      streamKey: "secret-key",
    });

    expect(parsed.resolution).toEqual({ width: 1920, height: 1080 });
    expect(parsed.fps).toBe(30);
    expect(parsed.videoBitrateKbps).toBe(6000);
    expect(parsed.keyframeSeconds).toBe(2);
    expect(parsed.audioBitrateKbps).toBe(128);
  });

  test("rejects dynamic RDP sizing by requiring fixed dimensions", () => {
    expect(() =>
      parseRdpConfig({
        host: "20.1.2.3",
        username: "demo",
        password: "password",
        width: 0,
        height: 1080,
      }),
    ).toThrow("width");
  });

  test("builds a masked stream destination for logs", () => {
    expect(
      buildSafeStreamDestination({
        platform: "generic",
        ingestUrl: "rtmp://live.example.test/app",
        streamKey: "abc123",
        resolution: { width: 1920, height: 1080 },
        fps: 30,
        videoBitrateKbps: 6000,
        audioBitrateKbps: 128,
        keyframeSeconds: 2,
      }),
    ).toBe("rtmp://live.example.test/app/********");
  });

  test("redacts RDP passwords and stream keys from arbitrary logs", () => {
    expect(
      redactSecrets("xfreerdp /p:secretpass streaming to rtmp://x/live/abc123", [
        "secretpass",
        "abc123",
      ]),
    ).toBe("xfreerdp /p:******** streaming to rtmp://x/live/********");
  });

  test("normalizes optional music sources", () => {
    expect(parseMusicSource(undefined)).toEqual({ kind: "none", volume: 0.3 });
    expect(
      parseMusicSource({ kind: "uploaded", path: "/data/music/theme.mp3" }),
    ).toEqual({
      kind: "uploaded",
      path: "/data/music/theme.mp3",
      volume: 0.3,
    });
    expect(
      parseMusicSource({
        kind: "url",
        url: "https://www.youtube.com/watch?v=CBSlu_VMS9U",
        volume: 0.45,
      }),
    ).toEqual({
      kind: "url",
      url: "https://www.youtube.com/watch?v=CBSlu_VMS9U",
      volume: 0.45,
    });
  });

  test("requires a path or URL for active music sources", () => {
    expect(() => parseMusicSource({ kind: "uploaded" })).toThrow("path");
    expect(() => parseMusicSource({ kind: "url" })).toThrow("url");
  });
});
