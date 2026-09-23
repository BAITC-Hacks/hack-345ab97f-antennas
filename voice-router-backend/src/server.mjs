import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Store } from "./store.mjs";
import { getConfig, loadEnv } from "./config.mjs";
import { DemoProvider, OpenAIProvider } from "./provider.mjs";
import { Engine, createSession, attachGateway } from "./gateway.mjs";
import { AppError, publicError } from "./errors.mjs";
import { textInput } from "./validation.mjs";

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}
async function body(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) throw new AppError("json_required", "Ожидается Content-Type: application/json.", 415);
  if (Number(request.headers["content-length"]) > 32768) throw new AppError("too_large", "Максимум 32 KiB.", 413);
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32768) throw new AppError("too_large", "Максимум 32 KiB.", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError("invalid_json", "Некорректный JSON."); }
}
const assets = new Map([["/",["index.html","text/html"]],["/index.html",["index.html","text/html"]],["/styles.css",["styles.css","text/css"]],["/app.js",["app.js","text/javascript"]],["/gateway.js",["gateway.js","text/javascript"]]]);
export async function createBackend({ config = getConfig(), provider, store } = {}) {
  const ownedStore = !store;
  store ||= await new Store(config.dataDir).init();
  provider ||= config.mode === "openai" ? new OpenAIProvider(config) : new DemoProvider();
  const engine = new Engine({ store, config, provider });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
  const validateRequest = request => {
    const host = request.headers.host || "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) throw new AppError("invalid_host", "Только локальный доступ.", 403);
    const origin = request.headers.origin;
    const allowed = new Set([...(config.origins || []), `http://127.0.0.1:${server.address()?.port}`, `http://localhost:${server.address()?.port}`]);
    if (origin && !allowed.has(origin)) throw new AppError("invalid_origin", "Origin не разрешён.", 403);
    if (request.headers["sec-fetch-site"] === "cross-site") throw new AppError("cross_site", "Cross-site запрос отклонён.", 403);
    return { host, origin };
  };
  const server = createServer(async (request, response) => {
    try {
      const { host, origin } = validateRequest(request);
      if (origin) { response.setHeader("Access-Control-Allow-Origin", origin); response.setHeader("Vary", "Origin"); }
      const url = new URL(request.url || "/", `http://${host}`);
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,PATCH,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }); response.end(); return;
      }
      if (url.pathname === "/api/health" && request.method === "GET") return json(response, 200, { ok: true, mode: config.mode, voiceEnabled: config.voiceEnabled, openaiConfigured: Boolean(config.apiKey), catalogVersion: store.catalog().version });
      if (url.pathname === "/api/catalog") {
        if (request.method === "GET") return json(response, 200, store.catalog());
        if (request.method === "POST") return json(response, 200, await store.upsert(await body(request)));
      }
      const catalogMatch = url.pathname.match(/^\/api\/catalog\/([a-z][a-z0-9_]{2,63})$/);
      if (catalogMatch) {
        if (request.method === "DELETE") return json(response, 200, await store.deleteScenario(catalogMatch[1]));
        if (request.method === "PUT") {
          const input = await body(request);
          if (input?.id !== catalogMatch[1]) throw new AppError("id_mismatch", "ID в URL и JSON должны совпадать.");
          return json(response, 200, await store.upsert(input));
        }
      }
      if (url.pathname === "/api/route" && request.method === "POST") {
        const input = await body(request);
        const text = textInput(input?.text), controller = new AbortController();
        response.once("close", () => { if (!response.writableEnded) controller.abort(); });
        const result = await engine.run(createSession(), { text }, undefined, controller.signal);
        return json(response, 200, result);
      }
      if (url.pathname === "/api/traces" && request.method === "GET") {
        const limit = Number(url.searchParams.get("limit") || 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new AppError("invalid_limit", "limit: 1..500.");
        return json(response, 200, { items: store.traces(limit, url.searchParams.get("mode") || undefined) });
      }
      if (url.pathname === "/api/supervisor" && request.method === "GET") return json(response, 200, store.metrics(config.mode));
      if (url.pathname === "/api/handoffs" && request.method === "GET") return json(response, 200, { items: store.handoffs() });
      const handoffMatch = url.pathname.match(/^\/api\/handoffs\/([a-f0-9-]{36})$/);
      if (handoffMatch && request.method === "PATCH") {
        const input = await body(request);
        if (input?.status !== "closed") throw new AppError("invalid_status", "Разрешён status=closed.");
        return json(response, 200, await store.resolveHandoff(handoffMatch[1]));
      }
      if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "not_found", message: "Endpoint или метод не найден." });
      if (!["GET","HEAD"].includes(request.method)) throw new AppError("method_not_allowed", "Метод недоступен.", 405);
      if (url.pathname === "/" && !url.searchParams.has("gateway")) {
        url.searchParams.set("gateway", `ws://${host}/ws`);
        response.writeHead(302, { Location: url.pathname + url.search, "Cache-Control": "no-store" }); response.end(); return;
      }
      const asset = assets.get(url.pathname);
      if (!asset) throw new AppError("not_found", "Файл не найден.", 404);
      const data = await readFile(resolve(config.frontendDir, asset[0]));
      response.writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      response.end(request.method === "HEAD" ? undefined : data);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, error.status || 500, publicError(error));
      else response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {});
    try {
      validateRequest(request);
      if (new URL(request.url, "http://localhost").pathname !== "/ws") throw new AppError("not_found", "Not found", 404);
      if (wss.clients.size >= 16) throw new AppError("busy", "Too many clients", 503);
      wss.handleUpgrade(request, socket, head, ws => wss.emit("connection", ws, request));
    } catch (error) { socket.end(`HTTP/1.1 ${error.status || 400} Rejected\r\nConnection: close\r\n\r\n`); }
  });
  wss.on("connection", ws => {
    ws.alive = true; ws.on("pong", () => { ws.alive = true; });
    attachGateway(ws, engine);
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
  }, 30000);
  heartbeat.unref();
  return {
    server, wss, engine, store,
    async listen(port = config.port) {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, config.host, () => { server.removeListener("error", reject); resolve(); }); });
      return server.address();
    },
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      // In-flight requests receive cancellation before the store lock is released.
      while (engine.active) await new Promise(resolve => setTimeout(resolve, 20));
      if (ownedStore) await store.close();
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const backend = await createBackend();
  try {
    const address = await backend.listen();
    console.log(`Tyńda backend: http://127.0.0.1:${address.port} | mode=${backend.engine.config.mode}`);
    console.log("Local development only. Use synthetic data; no real banking actions.");
  } catch (error) { await backend.close(); console.error("Startup failed:", error.code || "configuration"); process.exitCode = 1; }
  let stopping = false;
  for (const name of ["SIGINT","SIGTERM"]) process.on(name, async () => {
    if (stopping) return; stopping = true; await backend.close(); process.exitCode = 0;
  });
}
