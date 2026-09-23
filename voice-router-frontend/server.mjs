import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const assets = new Map([
  ["/", ["index.html", "text/html"]],
  ["/index.html", ["index.html", "text/html"]],
  ["/styles.css", ["styles.css", "text/css"]],
  ["/app.js", ["app.js", "text/javascript"]],
  ["/gateway.js", ["gateway.js", "text/javascript"]],
]);

// Only these settings are read; an existing environment value takes precedence.
export function loadDotEnv(directory = root, env = process.env, filename = ".env") {
  let source;
  try { source = readFileSync(join(directory, filename), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(OPENAI_API_KEY|OPENAI_MODEL|PORT)\s*=\s*(.*?)\s*$/);
    if (!match || env[match[1]] !== undefined) continue;
    const value = match[2];
    env[match[1]] = /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, "");
  }
}

export function extractOutputText(payload) {
  return (Array.isArray(payload.output) ? payload.output : [])
    .filter((item) => item.type === "message")
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text).join("\n").trim();
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8192) throw Object.assign(new Error("too_large"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("invalid_json"), { status: 400 }); }
}

// Local development proxy, not an authenticated public service.
export function createAppServer({ env = process.env, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  let activeRequests = 0;
  return createServer(async (request, response) => {
    try {
      const host = request.headers.host || "";
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return json(response, 403, { error: "invalid_host" });
      const url = new URL(request.url || "/", `http://${host}`);
      if (request.headers.origin && request.headers.origin !== url.origin) return json(response, 403, { error: "invalid_origin" });
      if (request.headers["sec-fetch-site"] === "cross-site") return json(response, 403, { error: "cross_site_request" });
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json(response, 200, { ok: true, openaiConfigured: Boolean(env.OPENAI_API_KEY) });
      }
      if (url.pathname === "/api/route") {
        if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) return json(response, 415, { error: "json_required" });
        const body = await readBody(request);
        if (typeof body?.text !== "string" || !body.text.trim() || body.text.trim().length > 600) return json(response, 400, { error: "invalid_text" });
        if (!env.OPENAI_API_KEY) return json(response, 503, { error: "not_configured" });
        if (activeRequests >= 2) return json(response, 429, { error: "busy" });
        activeRequests++;
        try {
          const result = await fetchImpl("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
            signal: AbortSignal.timeout(timeoutMs),
            body: JSON.stringify({
              model: env.OPENAI_MODEL || "gpt-5-mini", store: false, max_output_tokens: 1200,
              instructions: "You are a Voice Router connection smoke-test, not the production router. Briefly acknowledge the request in its language. Do not claim access to payments, policies or accounts. Do not claim any action was executed or scenario selected.",
              input: body.text.trim(),
            }),
          });
          if (!result.ok) {
            const error = result.status === 401 || result.status === 403 ? "api_auth" : result.status === 429 ? "api_limit" : "upstream_error";
            return json(response, 502, { error });
          }
          const payload = await result.json();
          const text = extractOutputText(payload);
          if (!text || payload.status === "incomplete") return json(response, 502, { error: "empty_response" });
          return json(response, 200, { text, mode: "smoke-test" });
        } catch (error) {
          return json(response, error.name === "TimeoutError" ? 504 : 502, { error: error.name === "TimeoutError" ? "timeout" : "upstream_error" });
        } finally { activeRequests--; }
      }
      if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "method_not_allowed" });
      const asset = assets.get(url.pathname);
      if (!asset) return json(response, 404, { error: "not_found" });
      const content = await readFile(join(root, asset[0]));
      response.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : "server_error" });
      else response.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadDotEnv();
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
  const server = createAppServer();
  server.on("error", (error) => { console.error(`Server startup failed: ${error.code || "unknown"}`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`Tyńda frontend: http://127.0.0.1:${port}`));
}
