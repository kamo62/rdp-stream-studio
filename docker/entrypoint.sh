#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY_ID:-:99}"
export PULSE_SERVER="${PULSE_SERVER:-unix:/tmp/pulse/native}"
pids=()

cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  wait "${pids[@]}" >/dev/null 2>&1 || true
}

trap 'cleanup; exit 143' INT TERM
trap cleanup EXIT

mkdir -p /tmp/pulse /tmp/rdp-stream-studio /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix
rm -f /tmp/pulse/native

if ! pulseaudio \
  --daemonize=yes \
  --exit-idle-time=-1 \
  --log-target=stderr \
  --load="module-native-protocol-unix socket=/tmp/pulse/native auth-anonymous=1"; then
  echo "PulseAudio failed to start; continuing without blocking RDP desktop startup." >&2
fi

pulse_ready=false
for _ in $(seq 1 30); do
  if pactl --server="$PULSE_SERVER" info >/dev/null 2>&1; then
    pulse_ready=true
    break
  fi
  sleep 0.2
done

if [ "$pulse_ready" != true ]; then
  echo "Timed out waiting for PulseAudio server $PULSE_SERVER; continuing without audio." >&2
else
  pactl --server="$PULSE_SERVER" load-module module-null-sink sink_name=rdp_stream sink_properties=device.description=RDP-Stream || true
fi

display_number="${DISPLAY#*:}"
display_number="${display_number%%.*}"
display_socket="/tmp/.X11-unix/X${display_number}"
rm -f "/tmp/.X${display_number}-lock" "$display_socket"

Xvfb "$DISPLAY" -screen 0 "${RDP_WIDTH:-1920}x${RDP_HEIGHT:-1080}x24" -nolisten tcp &
xvfb_pid=$!
pids+=("$xvfb_pid")

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
openbox_pid=$!
pids+=("$openbox_pid")

x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -quiet &
x11vnc_pid=$!
pids+=("$x11vnc_pid")

websockify --web=/usr/share/novnc/ --heartbeat="${WEBSOCKIFY_HEARTBEAT_SECONDS:-30}" 6080 localhost:5900 &
websockify_pid=$!
pids+=("$websockify_pid")

bun --cwd /app/apps/server src/index.ts &
bun_pid=$!
pids+=("$bun_pid")

set +e
wait -n "${pids[@]}"
exit_code=$?
set -e

echo "A critical process exited with code $exit_code; stopping container for Docker restart." >&2
exit "$exit_code"
