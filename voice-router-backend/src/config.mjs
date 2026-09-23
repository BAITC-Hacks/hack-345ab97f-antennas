import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export function loadEnv(env = process.env) {
  let source;
  try { source = readFileSync(resolve(projectRoot, ".env"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const allowed = /^(PORT|ROUTER_MODE|OPENAI_API_KEY|OPENAI_MODEL|STT_MODEL|TTS_MODEL|TTS_VOICE|VOICE_ENABLED|OPENAI_TIMEOUT_MS|FRONTEND_ORIGINS|PYTHON_ROUTER_URL)$/;
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!match || !allowed.test(match[1]) || env[match[1]] !== undefined) continue;
    const value = match[2];
    env[match[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, "");
  }
}
export function getConfig(env = process.env) {
  const port = Number(env.PORT || 8000);
  const timeoutMs = Number(env.OPENAI_TIMEOUT_MS || 30000);
  const mode = env.ROUTER_MODE || "demo";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1..65535");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("OPENAI_TIMEOUT_MS must be 1000..120000");
  if (!["demo", "openai", "python"].includes(mode)) throw new Error("ROUTER_MODE must be demo, openai or python");
  if (mode === "openai" && !env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is required in openai mode");
  if (env.VOICE_ENABLED && !["true", "false"].includes(env.VOICE_ENABLED)) throw new Error("VOICE_ENABLED must be true or false");
  // python mode: the team's Python router decides (backend/app, POST /gateway/route); voice still uses OpenAI.
  if (mode === "python" && env.VOICE_ENABLED === "true" && !env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is required for voice in python mode");
  const pythonRouterUrl = (env.PYTHON_ROUTER_URL || "http://127.0.0.1:8001").replace(/\/+$/, "");
  if (!["http:", "https:"].includes(new URL(pythonRouterUrl).protocol)) throw new Error("PYTHON_ROUTER_URL must be http(s)");
  const origins = (env.FRONTEND_ORIGINS || "http://127.0.0.1:8787,http://localhost:8787").split(",").map(s => s.trim()).filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("FRONTEND_ORIGINS must contain exact loopback origins");
  }
  return {
    host: "127.0.0.1", port, mode, timeoutMs, origins,
    apiKey: env.OPENAI_API_KEY?.trim() || "",
    model: env.OPENAI_MODEL || "gpt-5-mini",
    sttModel: env.STT_MODEL || "gpt-transcribe",
    ttsModel: env.TTS_MODEL || "gpt-4o-mini-tts",
    voice: env.TTS_VOICE || "coral",
    voiceEnabled: ["openai", "python"].includes(mode) && env.VOICE_ENABLED === "true",
    pythonRouterUrl,
    dataDir: resolve(projectRoot, "data"),
    frontendDir: resolve(projectRoot, "../voice-router-frontend"),
  };
}
