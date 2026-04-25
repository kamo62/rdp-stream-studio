# Architecture

```text
Browser WebUI
  -> Bun API
  -> Xvfb virtual display
  -> xfreerdp to Windows/Azure VM
  -> x11vnc + noVNC for browser control
  -> ffmpeg captures Xvfb and PulseAudio
  -> RTMP/RTMPS to YouTube/Twitch
```

The app keeps OBS and livestream encoding off the Windows VM. The VM emits only
the RDP remote-desktop stream. The container handles capture, optional music
mixing, and public livestream upload.

## Runtime Processes

- `Xvfb` creates a stable 1920x1080 virtual display.
- `xfreerdp` renders the Windows session into that display.
- `x11vnc` exposes the same display as VNC.
- `noVNC` lets the browser control the VNC session.
- `ffmpeg` captures the virtual display and PulseAudio monitor source.

## v1 Boundaries

- Webcam overlay is intentionally out of v1.
- Background music is supported as an uploaded looping audio file.
- Hardware encoding is intentionally out of v1 for portability.
