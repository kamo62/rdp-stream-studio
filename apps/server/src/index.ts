import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StudioProcessManager } from "./process-manager";

const port = Number(process.env.PORT ?? 3000);
const uploadDir = process.env.MUSIC_UPLOAD_DIR ?? "/tmp/rdp-stream-studio";
const manager = new StudioProcessManager({ musicCacheDir: uploadDir });
const webDistDir =
  process.env.WEB_DIST_DIR ?? new URL("../../web/dist", import.meta.url).pathname;
const publicNoVncUrl = process.env.PUBLIC_NOVNC_URL;

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

async function parseJson(request: Request): Promise<unknown> {
  if (!request.body) {
    return {};
  }
  return request.json();
}

async function saveMusicUpload(request: Request): Promise<string | undefined> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return undefined;
  }

  await mkdir(uploadDir, { recursive: true });
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = join(uploadDir, `${Date.now()}-${safeName}`);
  await writeFile(path, new Uint8Array(await file.arrayBuffer()));
  manager.appendLog(`Uploaded music source ${safeName}.`);
  return path;
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (pathname.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (pathname.endsWith(".js")) {
    return "application/javascript; charset=utf-8";
  }
  if (pathname.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

async function staticResponse(pathname: string): Promise<Response> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = Bun.file(join(webDistDir, relativePath));
  if (await file.exists()) {
    return new Response(file, {
      headers: { "content-type": contentType(relativePath) },
    });
  }

  const fallback = Bun.file(join(webDistDir, "index.html"));
  if (await fallback.exists()) {
    return new Response(fallback, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return jsonResponse(
    {
      name: "RDP Stream Studio API",
      status: manager.getState(),
      novncUrl: "/vnc.html?autoconnect=1&resize=scale&path=websockify",
    },
    200,
  );
}

function runtimeConfig(request: Request): { noVncUrl: string } {
  if (publicNoVncUrl) {
    return { noVncUrl: publicNoVncUrl };
  }

  const url = new URL(request.url);
  return {
    noVncUrl: `${url.protocol}//${url.hostname}:6080/vnc.html?autoconnect=1&resize=scale&path=websockify`,
  };
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
        },
      });
    }

    try {
      if (url.pathname === "/api/status" && request.method === "GET") {
        return jsonResponse(manager.getState());
      }

      if (url.pathname === "/api/runtime-config" && request.method === "GET") {
        return jsonResponse(runtimeConfig(request));
      }

      if (url.pathname === "/api/sessions/connect" && request.method === "POST") {
        return jsonResponse(await manager.connect(await parseJson(request)));
      }

      if (
        url.pathname === "/api/sessions/disconnect" &&
        request.method === "POST"
      ) {
        return jsonResponse(await manager.disconnect());
      }

      if (url.pathname === "/api/stream/start" && request.method === "POST") {
        const body = (await parseJson(request)) as {
          stream?: unknown;
          musicSource?: unknown;
          musicPath?: string;
        };
        const musicSource =
          body.musicSource ??
          (body.musicPath ? { kind: "uploaded", path: body.musicPath } : undefined);
        return jsonResponse(await manager.startStream(body.stream, musicSource));
      }

      if (
        url.pathname === "/api/stream/restart-last" &&
        request.method === "POST"
      ) {
        return jsonResponse(await manager.restartLastStream());
      }

      if (url.pathname === "/api/stream/stop" && request.method === "POST") {
        return jsonResponse(await manager.stopStream());
      }

      if (url.pathname === "/api/music/upload" && request.method === "POST") {
        return jsonResponse({ path: await saveMusicUpload(request) });
      }

      return staticResponse(url.pathname);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      manager.appendLog(`Request failed: ${message}`);
      return jsonResponse({ error: message, status: manager.getState() }, 400);
    }
  },
});

console.log(`RDP Stream Studio API listening on http://localhost:${server.port}`);
