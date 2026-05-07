import {
  ChevronDown,
  Clipboard,
  Eye,
  EyeOff,
  Loader2,
  Radio,
  RefreshCcw,
  SatelliteDish,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  ChangeEvent,
  FormEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type StudioState = {
  rdp: "idle" | "connecting" | "connected" | "failed";
  stream: "idle" | "starting" | "live" | "failed";
  safeDestination?: string;
  lastStream?: {
    status: "active" | "interrupted";
    safeDestination: string;
    platform: StreamPlatform;
    ingestUrl: string;
    resolution: { width: number; height: number };
    fps: number;
    videoBitrateKbps: number;
    audioBitrateKbps: number;
    keyframeSeconds: number;
    musicSourceKind: MusicSourceMode;
    updatedAt: string;
    reason?: string;
    canRestart: boolean;
  };
  logs: string[];
};

type RuntimeConfig = {
  noVncUrl: string;
};

type RdpFormState = {
  host: string;
  port: string;
  domain: string;
  username: string;
  password: string;
};

type StreamPlatform = "youtube" | "twitch" | "generic";
type MusicSourceMode = "url" | "uploaded" | "none";
type StreamResolutionProfile = "1080p" | "720p";

type StreamFormState = {
  platform: StreamPlatform;
  ingestUrl: string;
  streamKey: string;
  resolutionProfile: StreamResolutionProfile;
  videoBitrateKbps: string;
  musicSourceMode: MusicSourceMode;
  musicUrl: string;
};

type PendingAction =
  | "connect"
  | "disconnect"
  | "startStream"
  | "restartStream"
  | "stopStream"
  | "uploadMusic";

type ModalMode = "rdp" | "stream";

type LogLine = {
  raw: string;
  time: string;
  source: string;
  severity: "error" | "warn" | "success" | "info";
  message: string;
};

const emptyState: StudioState = { rdp: "idle", stream: "idle", logs: [] };
const fallbackNoVncUrl =
  "http://localhost:6080/vnc.html?autoconnect=1&resize=scale&path=websockify";
const defaultRdpForm: RdpFormState = {
  host: "",
  port: "3389",
  domain: "",
  username: "",
  password: "",
};
const platformIngestUrls: Record<StreamPlatform, string> = {
  youtube: "rtmp://a.rtmp.youtube.com/live2",
  twitch: "rtmp://live.twitch.tv/app",
  generic: "",
};
const streamProfiles: Record<
  StreamResolutionProfile,
  {
    label: string;
    width: number;
    height: number;
    bitrateKbps: string;
  }
> = {
  "1080p": {
    label: "1080p30 · ideal",
    width: 1920,
    height: 1080,
    bitrateKbps: "6000",
  },
  "720p": {
    label: "720p30 · safer",
    width: 1280,
    height: 720,
    bitrateKbps: "3500",
  },
};
const defaultMusicUrl = "https://www.youtube.com/watch?v=CBSlu_VMS9U";
const defaultStreamForm: StreamFormState = {
  platform: "youtube",
  ingestUrl: platformIngestUrls.youtube,
  streamKey: "",
  resolutionProfile: "1080p",
  videoBitrateKbps: "6000",
  musicSourceMode: "url",
  musicUrl: defaultMusicUrl,
};
const rdpFormStorageKey = "rdp-stream-studio:rdp-form";
const streamFormStorageKey = "rdp-stream-studio:stream-form";

function readStoredForm<T extends Record<string, string>>(
  key: string,
  fallback: T,
): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }

    const parsed = JSON.parse(raw) as Partial<T>;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json()) as unknown;
  if (
    !response.ok &&
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof data.error === "string"
  ) {
    throw new Error(data.error);
  }
  return data as T;
}

function rdpStatusLabel(status: StudioState["rdp"]): string {
  const labels: Record<StudioState["rdp"], string> = {
    idle: "RDP · STANDBY",
    connecting: "RDP · TUNING",
    connected: "RDP · LINK",
    failed: "RDP · FAULT",
  };
  return labels[status];
}

function streamStatusLabel(status: StudioState["stream"]): string {
  const labels: Record<StudioState["stream"], string> = {
    idle: "STREAM · DOWN",
    starting: "STREAM · ARMING",
    live: "STREAM · ON-AIR",
    failed: "STREAM · FAULT",
  };
  return labels[status];
}

function parseLogLine(raw: string): LogLine {
  const match = raw.match(/^\[(?<iso>[^\]]+)]\s(?<message>.*)$/);
  const iso = match?.groups?.iso;
  const message = match?.groups?.message ?? raw;
  const lower = message.toLowerCase();
  const sourceMatch = message.match(/^(?<source>xfreerdp|ffmpeg|stream|rdp|request):?/i);
  const source = sourceMatch?.groups?.source?.toLowerCase() ?? "sys";

  let severity: LogLine["severity"] = "info";
  if (lower.includes("error") || lower.includes("failed") || lower.includes("fault")) {
    severity = "error";
  } else if (lower.includes("warn")) {
    severity = "warn";
  } else if (lower.includes("connected") || lower.includes("streaming to")) {
    severity = "success";
  }

  return {
    raw,
    time: iso ? new Date(iso).toLocaleTimeString("en-GB") : "--:--:--",
    source,
    severity,
    message,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function App() {
  const [state, setState] = useState<StudioState>(emptyState);
  const [error, setError] = useState<string>();
  const [musicPath, setMusicPath] = useState<string>();
  const [musicFile, setMusicFile] = useState<File>();
  const [pending, setPending] = useState<PendingAction>();
  const [modal, setModal] = useState<ModalMode>();
  const [showRdpPassword, setShowRdpPassword] = useState(false);
  const [showStreamKey, setShowStreamKey] = useState(false);
  const [customIngestUrl, setCustomIngestUrl] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [clearedLogCount, setClearedLogCount] = useState(0);
  const [rdpForm, setRdpForm] = useState<RdpFormState>(() =>
    readStoredForm(rdpFormStorageKey, defaultRdpForm),
  );
  const [streamForm, setStreamForm] = useState<StreamFormState>(() =>
    readStoredForm(streamFormStorageKey, defaultStreamForm),
  );
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>({
    noVncUrl: fallbackNoVncUrl,
  });

  const visibleLogs = useMemo(
    () => state.logs.slice(clearedLogCount).map(parseLogLine),
    [clearedLogCount, state.logs],
  );
  const latestLog = visibleLogs.at(-1);
  const isLive = state.stream === "live";

  useEffect(() => {
    void fetch("/api/runtime-config")
      .then((response) => response.json())
      .then((data: RuntimeConfig) => setRuntimeConfig(data))
      .catch(() => undefined);

    const id = setInterval(() => {
      void fetch("/api/status")
        .then((response) => response.json())
        .then((data: StudioState) => setState(data))
        .catch(() => undefined);
    }, 1500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(rdpFormStorageKey, JSON.stringify(rdpForm));
  }, [rdpForm]);

  useEffect(() => {
    window.localStorage.setItem(
      streamFormStorageKey,
      JSON.stringify(streamForm),
    );
  }, [streamForm]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setModal(undefined);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function runAction(action: PendingAction, task: () => Promise<void>) {
    setError(undefined);
    setPending(action);
    try {
      await task();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setPending(undefined);
    }
  }

  async function connect() {
    await runAction("connect", async () => {
      const next = await postJson<StudioState>("/api/sessions/connect", {
        host: rdpForm.host,
        port: Number(rdpForm.port),
        username: rdpForm.username,
        password: rdpForm.password,
        domain: rdpForm.domain || undefined,
        width: 1920,
        height: 1080,
        ignoreCertificate: true,
      });
      setState(next);
      setModal(undefined);
    });
  }

  async function disconnectRdp() {
    await runAction("disconnect", async () => {
      const next = await postJson<StudioState>("/api/sessions/disconnect");
      setState(next);
    });
  }

  async function uploadSelectedMusic(): Promise<string | undefined> {
    if (!musicFile) {
      return musicPath;
    }

    const form = new FormData();
    form.append("file", musicFile);
    const response = await fetch("/api/music/upload", {
      method: "POST",
      body: form,
    });
    const data = (await response.json()) as { path?: string; error?: string };
    if (!response.ok) {
      throw new Error(data.error ?? "Music upload failed");
    }
    setMusicPath(data.path);
    return data.path;
  }

  async function startStream() {
    await runAction("startStream", async () => {
      const profile = streamProfiles[streamForm.resolutionProfile];
      const uploadedMusicPath =
        streamForm.musicSourceMode === "uploaded"
          ? await uploadSelectedMusic()
          : undefined;
      const musicSource =
        streamForm.musicSourceMode === "url" && streamForm.musicUrl.trim()
          ? {
              kind: "url",
              url: streamForm.musicUrl.trim(),
              volume: 0.3,
            }
          : streamForm.musicSourceMode === "uploaded" && uploadedMusicPath
            ? {
                kind: "uploaded",
                path: uploadedMusicPath,
                volume: 0.3,
              }
            : { kind: "none", volume: 0.3 };
      const next = await postJson<StudioState>("/api/stream/start", {
        musicSource,
        stream: {
          platform: streamForm.platform,
          ingestUrl: streamForm.ingestUrl,
          streamKey: streamForm.streamKey,
          resolution: { width: profile.width, height: profile.height },
          fps: 30,
          videoBitrateKbps: Number(streamForm.videoBitrateKbps),
          audioBitrateKbps: 128,
          keyframeSeconds: 2,
        },
      });
      setState(next);
      setModal(undefined);
    });
  }

  async function stopStream() {
    await runAction("stopStream", async () => {
      const next = await postJson<StudioState>("/api/stream/stop");
      setState(next);
    });
  }

  async function restartStream() {
    await runAction("restartStream", async () => {
      const next = await postJson<StudioState>("/api/stream/restart-last");
      setState(next);
    });
  }

  function connectFromForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void connect();
  }

  function startStreamFromForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void startStream();
  }

  function changePlatform(platform: StreamPlatform) {
    setStreamForm((current) => ({
      ...current,
      platform,
      ingestUrl: customIngestUrl ? current.ingestUrl : platformIngestUrls[platform],
    }));
  }

  function changeIngestUrl(value: string) {
    setCustomIngestUrl(value !== platformIngestUrls[streamForm.platform]);
    setStreamForm({ ...streamForm, ingestUrl: value });
  }

  function changeStreamProfile(profile: StreamResolutionProfile) {
    setStreamForm({
      ...streamForm,
      resolutionProfile: profile,
      videoBitrateKbps: streamProfiles[profile].bitrateKbps,
    });
  }

  function clearMusicFile() {
    setMusicFile(undefined);
    setMusicPath(undefined);
  }

  async function copyLogs() {
    await navigator.clipboard.writeText(visibleLogs.map((line) => line.raw).join("\n"));
  }

  return (
    <main className={`deckShell ${isLive ? "isLive" : ""}`}>
      <aside className="orientationStrip" aria-hidden="true">
        RDP-STREAM-STUDIO · v0.1 · TX-DECK
      </aside>

      <section className="studioFrame">
        <Topbar rdp={state.rdp} stream={state.stream} />

        {error ? (
          <div className="errorBox" role="alert">
            <span>FAULT</span>
            {error}
            <button type="button" onClick={() => setError(undefined)} aria-label="Dismiss error">
              <X size={15} />
            </button>
          </div>
        ) : null}

        <PreviewPane
          rdpStatus={state.rdp}
          streamStatus={state.stream}
          noVncUrl={runtimeConfig.noVncUrl}
        />

        <TransportBar
          state={state}
          pending={pending}
          latestLog={latestLog}
          logsOpen={logsOpen}
          onStartRdp={() => setModal("rdp")}
          onStopRdp={() => void disconnectRdp()}
          onStartStream={() => setModal("stream")}
          onRestartStream={() => void restartStream()}
          onStopStream={() => void stopStream()}
          onToggleLogs={() => setLogsOpen((open) => !open)}
        />

        <LogDrawer
          open={logsOpen}
          logs={visibleLogs}
          onCopy={() => void copyLogs()}
          onClear={() => setClearedLogCount(state.logs.length)}
        />
      </section>

      {modal === "rdp" ? (
        <Modal title="CH 01 — RDP LINK" onClose={() => setModal(undefined)}>
          <form className="moduleForm" onSubmit={connectFromForm}>
            <Field label="Host">
              <input
                name="host"
                placeholder="20.1.2.3"
                required
                value={rdpForm.host}
                onChange={(event) =>
                  setRdpForm({ ...rdpForm, host: event.currentTarget.value })
                }
              />
            </Field>
            <div className="grid2">
              <Field label="Port" unit="TCP">
                <input
                  name="port"
                  type="number"
                  required
                  value={rdpForm.port}
                  onChange={(event) =>
                    setRdpForm({ ...rdpForm, port: event.currentTarget.value })
                  }
                />
              </Field>
              <Field label="Domain">
                <input
                  name="domain"
                  placeholder="optional"
                  value={rdpForm.domain}
                  onChange={(event) =>
                    setRdpForm({ ...rdpForm, domain: event.currentTarget.value })
                  }
                />
              </Field>
            </div>
            <Field label="Username">
              <input
                name="username"
                required
                value={rdpForm.username}
                onChange={(event) =>
                  setRdpForm({ ...rdpForm, username: event.currentTarget.value })
                }
              />
            </Field>
            <Field label="Password">
              <SecretInput
                name="password"
                value={rdpForm.password}
                visible={showRdpPassword}
                onToggle={() => setShowRdpPassword((visible) => !visible)}
                onChange={(value) => setRdpForm({ ...rdpForm, password: value })}
              />
            </Field>
            <div className="modalActions">
              <button type="button" className="ghostButton" onClick={() => setModal(undefined)}>
                Cancel
              </button>
              <button type="submit" className="primaryButton" disabled={pending === "connect"}>
                {pending === "connect" ? <Loader2 className="spin" size={17} /> : <SatelliteDish size={17} />}
                {pending === "connect" ? "Tuning Link" : "Connect RDP"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {modal === "stream" ? (
        <Modal title="CH 02 — TRANSMIT" onClose={() => setModal(undefined)}>
          <form className="moduleForm" onSubmit={startStreamFromForm}>
            <Field label="Platform">
              <select
                name="platform"
                value={streamForm.platform}
                onChange={(event) =>
                  changePlatform(event.currentTarget.value as StreamPlatform)
                }
              >
                <option value="youtube">YouTube</option>
                <option value="twitch">Twitch</option>
                <option value="generic">Generic RTMP</option>
              </select>
            </Field>
            <Field label={`Ingest URL · ${customIngestUrl ? "custom" : "auto"}`}>
              <input
                name="ingestUrl"
                required
                value={streamForm.ingestUrl}
                onChange={(event) => changeIngestUrl(event.currentTarget.value)}
              />
            </Field>
            <Field label="Stream Key">
              <SecretInput
                name="streamKey"
                value={streamForm.streamKey}
                visible={showStreamKey}
                onToggle={() => setShowStreamKey((visible) => !visible)}
                onChange={(value) =>
                  setStreamForm({ ...streamForm, streamKey: value })
                }
              />
            </Field>
            <Field label="Output Profile">
              <select
                name="resolutionProfile"
                value={streamForm.resolutionProfile}
                onChange={(event) =>
                  changeStreamProfile(
                    event.currentTarget.value as StreamResolutionProfile,
                  )
                }
              >
                {Object.entries(streamProfiles).map(([value, profile]) => (
                  <option key={value} value={value}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Video Bitrate" unit="KBPS">
              <input
                name="videoBitrateKbps"
                type="number"
                min="1000"
                max="51000"
                value={streamForm.videoBitrateKbps}
                onChange={(event) =>
                  setStreamForm({
                    ...streamForm,
                    videoBitrateKbps: event.currentTarget.value,
                  })
                }
              />
            </Field>
            <Field label="Music Bed">
              <div className="musicBedControls">
                <select
                  name="musicSourceMode"
                  value={streamForm.musicSourceMode}
                  onChange={(event) =>
                    setStreamForm({
                      ...streamForm,
                      musicSourceMode: event.currentTarget.value as MusicSourceMode,
                    })
                  }
                >
                  <option value="url">YouTube URL</option>
                  <option value="uploaded">Upload audio</option>
                  <option value="none">Off</option>
                </select>
                {streamForm.musicSourceMode === "url" ? (
                  <>
                    <input
                      name="musicUrl"
                      type="url"
                      value={streamForm.musicUrl}
                      onChange={(event) =>
                        setStreamForm({
                          ...streamForm,
                          musicUrl: event.currentTarget.value,
                        })
                      }
                    />
                    <p className="hint">Music provided by Lofi Girl: youtube.com/@LofiGirl</p>
                  </>
                ) : null}
                {streamForm.musicSourceMode === "uploaded" ? (
                  <>
                    <input
                      name="file"
                      type="file"
                      accept="audio/*"
                      onChange={(event) =>
                        setMusicFile(event.currentTarget.files?.[0])
                      }
                    />
                    {musicFile ? (
                      <button
                        type="button"
                        className="fileChip"
                        onClick={clearMusicFile}
                      >
                        <ChevronDown size={14} />
                        {musicFile.name} · {formatBytes(musicFile.size)}
                        <X size={14} />
                      </button>
                    ) : (
                      <p className="hint">Optional background music loop.</p>
                    )}
                  </>
                ) : null}
                {streamForm.musicSourceMode === "none" ? (
                  <p className="hint">No background music.</p>
                ) : null}
              </div>
            </Field>
            <div className="modalActions">
              <button type="button" className="ghostButton" onClick={() => setModal(undefined)}>
                Cancel
              </button>
              <button
                type="submit"
                className="primaryButton stream"
                disabled={pending === "startStream"}
              >
                {pending === "startStream" ? <Loader2 className="spin" size={17} /> : <Radio size={17} />}
                {pending === "startStream" ? "Arming Stream" : "Start Stream"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </main>
  );
}

function Topbar({
  rdp,
  stream,
}: {
  rdp: StudioState["rdp"];
  stream: StudioState["stream"];
}) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">Docker RDP capture</p>
        <h1>RDP Stream Studio</h1>
      </div>
      <div className="statusRack">
        <StatusLamp kind="rdp" state={rdp} label={rdpStatusLabel(rdp)} />
        <StatusLamp kind="stream" state={stream} label={streamStatusLabel(stream)} />
      </div>
    </header>
  );
}

function StatusLamp({
  kind,
  state,
  label,
}: {
  kind: "rdp" | "stream";
  state: string;
  label: string;
}) {
  return (
    <span className={`statusLamp ${kind} ${state}`}>
      <span className="lampDot" />
      {label}
    </span>
  );
}

function PreviewPane({
  rdpStatus,
  streamStatus,
  noVncUrl,
}: {
  rdpStatus: StudioState["rdp"];
  streamStatus: StudioState["stream"];
  noVncUrl: string;
}) {
  return (
    <section className="previewDeck">
      {rdpStatus === "connected" ? (
        <iframe title="RDP remote control" src={noVncUrl} />
      ) : (
        <div className="emptyPreview">
          <div className="crtFrame">
            <span className="crtLabel">NO SIGNAL</span>
            <span className="scanline" />
            <span className="carrierPulse">■ ■ ■</span>
          </div>
          <ol className="signalReceipt">
            <li className={rdpStatus === "connecting" ? "active typing" : "active"}>
              <span>01</span>
              {rdpStatus === "connecting" ? "ESTABLISHING..." : "ENTER RDP CREDENTIALS"}
            </li>
            <li>
              <span>02</span>
              CONFIGURE RTMP DESTINATION
            </li>
            <li>
              <span>03</span>
              GO LIVE
            </li>
          </ol>
        </div>
      )}
      {streamStatus === "live" ? (
        <div className="liveBadge">
          <span />
          ON AIR
        </div>
      ) : null}
    </section>
  );
}

function TransportBar({
  state,
  pending,
  latestLog,
  logsOpen,
  onStartRdp,
  onStopRdp,
  onStartStream,
  onRestartStream,
  onStopStream,
  onToggleLogs,
}: {
  state: StudioState;
  pending?: PendingAction;
  latestLog?: LogLine;
  logsOpen: boolean;
  onStartRdp: () => void;
  onStopRdp: () => void;
  onStartStream: () => void;
  onRestartStream: () => void;
  onStopStream: () => void;
  onToggleLogs: () => void;
}) {
  const canStream = state.rdp === "connected";
  const canRestartLast =
    state.stream !== "live" &&
    state.stream !== "starting" &&
    Boolean(state.lastStream?.canRestart);
  const visibleDestination = state.safeDestination ?? state.lastStream?.safeDestination;
  const visibleBitrate = state.lastStream
    ? `${state.lastStream.videoBitrateKbps} KBPS · ${state.lastStream.resolution.height}P${state.lastStream.fps}${
        state.stream === "live" ? "" : ` · SAVED ${state.lastStream.status.toUpperCase()}`
      }`
    : "6000 KBPS · 1080P30";

  return (
    <footer className="transport">
      <div className="buttonBank">
        {state.rdp === "connected" ? (
          <button
            type="button"
            className="stopButton"
            disabled={pending === "disconnect"}
            onClick={onStopRdp}
          >
            {pending === "disconnect" ? <Loader2 className="spin" size={17} /> : <Square size={17} />}
            Stop RDP
          </button>
        ) : (
          <button type="button" className="primaryButton" onClick={onStartRdp}>
            <SatelliteDish size={17} />
            Start RDP
          </button>
        )}

        {state.stream === "live" || state.stream === "starting" ? (
          <button
            type="button"
            className="stopButton"
            disabled={pending === "stopStream"}
            onClick={onStopStream}
          >
            {pending === "stopStream" ? <Loader2 className="spin" size={17} /> : <Square size={17} />}
            Stop Stream
          </button>
        ) : (
          <button
            type="button"
            className="primaryButton stream"
            disabled={!canStream}
            onClick={onStartStream}
          >
            <Radio size={17} />
            Start Stream
          </button>
        )}
        {canRestartLast ? (
          <button
            type="button"
            className="ghostButton"
            disabled={pending === "restartStream"}
            onClick={onRestartStream}
          >
            {pending === "restartStream" ? <Loader2 className="spin" size={17} /> : <RefreshCcw size={17} />}
            Restart Saved
          </button>
        ) : null}
      </div>

      <div
        className={`destinationStrip ${state.stream === "live" ? "active" : ""} ${
          state.lastStream && state.stream !== "live" ? "saved" : ""
        }`}
      >
        <span className="txDot" />
        OUT →
        <strong>{visibleDestination ?? "NO ACTIVE RTMP DESTINATION"}</strong>
        <span>· {visibleBitrate}</span>
      </div>

      <button type="button" className="logToggle" onClick={onToggleLogs}>
        LOG {latestLog ? `· ${latestLog.source.toUpperCase()}` : "· STANDBY"}
        <ChevronDown className={logsOpen ? "up" : ""} size={16} />
      </button>
    </footer>
  );
}

function LogDrawer({
  open,
  logs,
  onCopy,
  onClear,
}: {
  open: boolean;
  logs: LogLine[];
  onCopy: () => void;
  onClear: () => void;
}) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      logEndRef.current?.scrollIntoView({ block: "end" });
    }
  }, [logs, open]);

  return (
    <section className={`logDrawer ${open ? "open" : ""}`} aria-label="Transmission logs">
      <div className="logHeader">
        <span>LOG ▮ {logs.length || 0} LINES</span>
        <div>
          <button type="button" onClick={onCopy} disabled={logs.length === 0}>
            <Clipboard size={14} /> Copy
          </button>
          <button type="button" onClick={onClear} disabled={logs.length === 0}>
            <Trash2 size={14} /> Clear
          </button>
        </div>
      </div>
      <div className="logLines">
        {logs.length ? (
          logs.map((line, index) => (
            <div className={`logLine ${line.severity}`} key={`${line.raw}-${index}`}>
              <span className="logTime">{line.time}</span>
              <span className="logSource">[{line.source}]</span>
              <span className="logMessage">{line.message}</span>
            </div>
          ))
        ) : (
          <div className="logEmpty">Waiting for carrier telemetry.</div>
        )}
        <div ref={logEndRef} />
      </div>
    </section>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modalOverlay" role="presentation" onMouseDown={onClose}>
      <section
        className="modalPanel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modalHeader">
          <span>{title}</span>
          <button type="button" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function Field({
  label,
  unit,
  children,
}: {
  label: string;
  unit?: string;
  children: ReactNode;
}) {
  return (
    <label className={`field ${unit ? "hasUnit" : ""}`}>
      <span>{label}</span>
      <div className="inputShell">
        {children}
        {unit ? <em>{unit}</em> : null}
      </div>
    </label>
  );
}

function SecretInput({
  name,
  value,
  visible,
  onToggle,
  onChange,
}: {
  name: string;
  value: string;
  visible: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  return (
    <div className="secretInput">
      <input
        name={name}
        type={visible ? "text" : "password"}
        required
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.currentTarget.value)
        }
      />
      <button type="button" onClick={onToggle} aria-label={visible ? "Hide secret" : "Show secret"}>
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
