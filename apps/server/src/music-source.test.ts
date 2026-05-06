import { describe, expect, test } from "bun:test";
import {
  resolveMusicSource,
  type CommandResult,
  type CommandRunner,
} from "./music-source";

describe("music source resolution", () => {
  test("ignores an empty source", async () => {
    await expect(resolveMusicSource(undefined, "/tmp/music")).resolves.toBeUndefined();
  });

  test("passes uploaded files through as looped local inputs", async () => {
    await expect(
      resolveMusicSource(
        { kind: "uploaded", path: "/tmp/music/theme.mp3", volume: 0.5 },
        "/tmp/music",
      ),
    ).resolves.toEqual({
      input: "/tmp/music/theme.mp3",
      loop: true,
      volume: 0.5,
    });
  });

  test("downloads and caches YouTube audio sources", async () => {
    const calls: string[][] = [];
    let downloaded = false;
    const runCommand: CommandRunner = async (cmd): Promise<CommandResult> => {
      calls.push(cmd);
      if (cmd.includes("--skip-download")) {
        return {
          exitCode: 0,
          stdout: "CBSlu_VMS9U\nm4a\nLofi Girl\n",
          stderr: "",
        };
      }

      downloaded = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const resolved = await resolveMusicSource(
      { kind: "url", url: "https://www.youtube.com/watch?v=CBSlu_VMS9U" },
      "/tmp/rdp-stream-studio-test-cache",
      runCommand,
      async () => downloaded,
    );

    expect(resolved).toEqual({
      input: "/tmp/rdp-stream-studio-test-cache/youtube/CBSlu_VMS9U.m4a",
      loop: true,
      volume: 0.3,
      attribution: "Music provided by Lofi Girl: https://www.youtube.com/@LofiGirl",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--skip-download");
    expect(calls[1]).toContain("--paths");
    expect(calls[1]).toContain("/tmp/rdp-stream-studio-test-cache/youtube");
  });

  test("reuses cached YouTube audio when present", async () => {
    const calls: string[][] = [];
    const runCommand: CommandRunner = async (cmd): Promise<CommandResult> => {
      calls.push(cmd);
      return {
        exitCode: 0,
        stdout: "CBSlu_VMS9U\nm4a\nLofi Girl\n",
        stderr: "",
      };
    };

    const resolved = await resolveMusicSource(
      { kind: "url", url: "https://youtu.be/CBSlu_VMS9U" },
      "/tmp/rdp-stream-studio-test-cache",
      runCommand,
      async () => true,
    );

    expect(resolved?.input).toBe(
      "/tmp/rdp-stream-studio-test-cache/youtube/CBSlu_VMS9U.m4a",
    );
    expect(calls).toHaveLength(1);
  });

  test("rejects non-YouTube URL music sources", async () => {
    await expect(
      resolveMusicSource(
        { kind: "url", url: "https://example.com/music.mp3" },
        "/tmp/music",
      ),
    ).rejects.toThrow("Only YouTube URLs are supported");
  });
});
