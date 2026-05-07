#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY_ID:-:99}"
export PULSE_SERVER="${PULSE_SERVER:-unix:/tmp/pulse/native}"

mkdir -p /tmp/pulse /tmp/rdp-stream-studio
rm -f /tmp/pulse/native

pulseaudio \
  --daemonize=yes \
  --exit-idle-time=-1 \
  --log-target=stderr \
  --load="module-native-protocol-unix socket=/tmp/pulse/native auth-anonymous=1"

pulse_ready=false
for _ in $(seq 1 30); do
  if pactl --server="$PULSE_SERVER" info >/dev/null 2>&1; then
    pulse_ready=true
    break
  fi
  sleep 0.2
done

if [ "$pulse_ready" != true ]; then
  echo "Timed out waiting for PulseAudio server $PULSE_SERVER" >&2
  exit 1
fi

pactl --server="$PULSE_SERVER" load-module module-null-sink sink_name=rdp_stream sink_properties=device.description=RDP-Stream || true

Xvfb "$DISPLAY" -screen 0 "${RDP_WIDTH:-1920}x${RDP_HEIGHT:-1080}x24" -nolisten tcp &
xvfb_pid=$!

display_number="${DISPLAY#*:}"
display_number="${display_number%%.*}"
display_socket="/tmp/.X11-unix/X${display_number}"

for _ in $(seq 1 50); do
  if [ -S "$display_socket" ] && kill -0 "$xvfb_pid" >/dev/null 2>&1; then
    break
  fi

  if ! kill -0 "$xvfb_pid" >/dev/null 2>&1; then
    echo "Xvfb exited before display $DISPLAY was ready" >&2
    exit 1
  fi

  sleep 0.2
done

if [ ! -S "$display_socket" ]; then
  echo "Timed out waiting for Xvfb display socket $display_socket" >&2
  exit 1
fi

openbox &
x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -quiet &
websockify --web=/usr/share/novnc/ --heartbeat="${WEBSOCKIFY_HEARTBEAT_SECONDS:-30}" 6080 localhost:5900 &

exec bun --cwd /app/apps/server src/index.ts
