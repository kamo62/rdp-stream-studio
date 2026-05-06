# RDP Stream Studio

RDP Stream Studio is a Docker-hosted broadcast control surface for streaming a
remote Windows desktop without running OBS, ffmpeg, or a full livestream encoder
on that Windows machine.

The original use case is cost-aware livestreaming from an Azure VM:

```text
Azure VM screen
  -> lightweight RDP session
  -> local Docker container
  -> ffmpeg livestream upload to YouTube, Twitch, or any RTMP endpoint
```

The VM only sends a remote desktop session. The container handles capture,
encoding, audio routing, and the final outbound livestream.

## Why This Exists

Running OBS or ffmpeg directly on a cloud VM can make the VM responsible for the
full livestream upload. For long-running streams, that can create avoidable cloud
egress costs and makes stream tuning harder to control.

RDP Stream Studio keeps the heavy streaming work outside the VM:

- connect to a Windows VM over RDP;
- view and control that session through an embedded noVNC browser surface;
- capture the same virtual display inside the container;
- stream the captured display to YouTube, Twitch, or another RTMP/RTMPS target.

It is not a replacement for OBS as a full production switcher. It is a focused
tool for turning a remote desktop session into a livestream from a machine you
control locally.

## Current Features

- Browser-based "Transmission Deck" UI.
- Modal RDP connection flow.
- Embedded noVNC remote-control preview.
- RTMP/RTMPS stream setup for YouTube, Twitch, or a custom endpoint.
- Fixed 1080p30 streaming profile by default.
- Optional background music upload or YouTube music URL.
- PulseAudio routing inside the container.
- Redacted logs for RDP passwords and stream keys.
- Bottom log drawer with copy and UI-only clear controls.
- Docker runtime with FreeRDP, Xvfb, x11vnc, noVNC, PulseAudio, and ffmpeg.

## Architecture

```text
apps/web
  React + Vite browser UI

apps/server
  Bun API and process supervisor

packages/shared
  TypeScript schemas and shared helpers

docker
  Container entrypoint for Xvfb, PulseAudio, noVNC, x11vnc, and the Bun server
```

At runtime, the server supervises two main processes:

- `xfreerdp3` connects to the Windows VM and renders into the virtual X display.
- `ffmpeg` captures that virtual display and PulseAudio monitor source, then
  pushes the encoded stream to the configured RTMP endpoint.

## Quick Start

Install dependencies and verify the app:

```bash
bun install
bun test
bun run typecheck
bun run lint
bun run build
```

Build and run the Docker image:

```bash
docker build -t rdp-stream-studio .
docker run --rm -p 3000:3000 -p 6080:6080 rdp-stream-studio
```

Open:

- Web UI: `http://localhost:3000`
- noVNC directly: `http://localhost:6080/vnc.html`

If you map noVNC to a different host port, set `PUBLIC_NOVNC_URL` so the
embedded iframe points at the correct public URL:

```bash
docker run --rm \
  -p 3001:3000 \
  -p 6081:6080 \
  -e PUBLIC_NOVNC_URL="http://localhost:6081/vnc.html?autoconnect=1&resize=scale&path=websockify" \
  rdp-stream-studio
```

Then open `http://localhost:3001`.

noVNC is proxied through websockify with heartbeat pings enabled by default so
long-running browser control sessions are less likely to be dropped by idle
network intermediaries:

```text
WEBSOCKIFY_HEARTBEAT_SECONDS=30
```

## Streaming Defaults

- Resolution: 1920x1080
- FPS: 30
- Video codec: H.264 via `libx264`
- Audio codec: AAC
- Audio bitrate: 128 kbps
- Audio sample rate: 44.1 kHz
- Keyframe interval: 2 seconds
- Rate control: constrained bitrate with `-b:v`, `-maxrate`, and `-bufsize`
- Output profiles: 1080p30 at 6000 kbps by default, with a 720p30 at 3500 kbps
  fallback for stability.

The 720p profile captures the full 1920x1080 RDP display and scales it down in
ffmpeg, rather than cropping the desktop.

## Background Music

The stream modal can use no music, an uploaded audio file, or a YouTube music
video URL. The default URL is the Lofi Girl 3-hour jazz lofi mix:

```text
https://www.youtube.com/watch?v=CBSlu_VMS9U
```

For YouTube URLs, the server uses `yt-dlp` to cache the selected audio in
`MUSIC_UPLOAD_DIR` and then loops that cached file in ffmpeg. This avoids
long-running stream failures from expired signed media URLs.

The Docker image includes `yt-dlp` and Node.js for YouTube extraction. If you run
the server directly outside Docker, install `yt-dlp` and Node.js locally first.

Only use music that you are allowed to rebroadcast, and include the attribution
required by the source. For the default Lofi Girl source, include:

```text
Music provided by Lofi Girl: https://www.youtube.com/@LofiGirl
```

## Example YouTube RTMP Setup

In the app:

1. Click `Start RDP` and enter the Windows VM RDP details.
2. Wait for the noVNC preview to show the remote desktop.
3. Click `Start Stream`.
4. Choose `YouTube`.
5. Use YouTube's ingest URL, usually:

```text
rtmp://a.rtmp.youtube.com/live2
```

6. Paste your YouTube stream key.
7. Start the stream.

## Stream Recovery

When a stream starts, the server writes the last stream settings to
`MUSIC_UPLOAD_DIR/last-stream.json`. The app marks that record as stopped only
when the user explicitly stops the stream. If `ffmpeg` exits unexpectedly or the
container restarts while a stream was marked active, `/api/status` exposes a
redacted recovery summary and the UI shows `Restart Saved`.

Automatic restart is enabled by default. It retries interrupted streams with
backoff, and after a container restart it can recreate the saved RDP session
before restarting ffmpeg.

Useful restart controls:

```text
AUTO_RESTART_STREAM=true
AUTO_RESTART_MAX_ATTEMPTS=12
AUTO_RESTART_INITIAL_DELAY_MS=5000
AUTO_RESTART_MAX_DELAY_MS=60000
AUTO_RESTART_STARTUP_DELAY_MS=15000
AUTO_RESTART_RDP_WARMUP_MS=8000
AUTO_RESTART_STABLE_AFTER_MS=60000
```

The recovery file is written with `0600` permissions because it contains the
private stream key and RDP password needed for automatic restart. Keep
`MUSIC_UPLOAD_DIR` on trusted storage and do not commit or share
`last-stream.json`.

## Security Notes

This is an early public version intended for trusted local or private-network
use.

- Do not expose the container directly to the public internet.
- Put authentication and TLS in front of it before any shared deployment.
- RDP passwords and stream keys are redacted in logs, but they are still handled
  by the running process in memory.
- The stream recovery file stores the last stream key and RDP password on disk
  so interrupted streams can be restarted automatically.
- Treat stream keys like passwords and rotate them if they are exposed.

## Roadmap Ideas

- Saved RDP profiles.
- Stream quality presets beyond the default 1080p30 profile.
- Hardware encoder support where available.
- Authentication for shared deployments.
- More robust audio mixing controls.
- SSE or WebSocket log streaming instead of polling.
