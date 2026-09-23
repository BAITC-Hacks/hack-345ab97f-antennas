import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "../src/config.mjs";
import { PythonProvider } from "../src/provider.mjs";
import { createBackend } from "../src/server.mjs";
import { createSession } from "../src/gateway.mjs";

const catalog = JSON.parse(await readFile(new URL("../catalog.seed.json", import.meta.url), "utf8"));
const decision = {
  scenario_id: "policy_renewal", decision: "route", confidence: 0.97, language: "mixed",
  reason: "Клиент просит продлить полис", response_text: "Помогу с вопросом «Продление полиса».",
  additional_intents: [{ scenario_id: "quote_policy_price", confidence: 0.97 }],
  alternatives: [{ scenario_id: "new_policy", confidence: 0.02, why_not: "Полис уже есть" }],
  router: { final_action: "route" },
};
const reply = (body, status = 200) => async (url, options) => {
  reply.calls.push({ url, body: JSON.parse(options.body) });
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
};

test("python mode needs no OpenAI key unless voice is on; router URL is normalised", () => {
  const config = getConfig({ ROUTER_MODE: "python", PYTHON_ROUTER_URL: "http://127.0.0.1:8001/" });
  assert.equal(config.mode, "python");
  assert.equal(config.pythonRouterUrl, "http://127.0.0.1:8001");
  assert.equal(config.voiceEnabled, false);
  assert.throws(() => getConfig({ ROUTER_MODE: "python", VOICE_ENABLED: "true" }), /voice in python mode/);
  assert.equal(getConfig({ ROUTER_MODE: "python", VOICE_ENABLED: "true", OPENAI_API_KEY: "k" }).voiceEnabled, true);
  assert.throws(() => getConfig({ ROUTER_MODE: "python", PYTHON_ROUTER_URL: "ftp://x" }), /http/);
});

test("PythonProvider sends catalog and session, returns a validated decision", async () => {
  reply.calls = [];
  const provider = new PythonProvider(getConfig({ ROUTER_MODE: "python" }), reply(decision));
  const session = { ...createSession(), activeScenario: "policy_renewal", clarifyCount: 1,
    history: [{ role: "user", content: "Продлите мой полис" }] };
  const result = await provider.route({ text: "Полисімді продлить керек", catalog, session });
  const [call] = reply.calls;
  assert.equal(call.url, "http://127.0.0.1:8001/gateway/route");
  assert.deepEqual(call.body.session, { history: session.history, active_scenario: "policy_renewal", pending_intents: [], clarify_count: 1 });
  assert.equal(call.body.catalog.length, catalog.length);
  assert.equal(result.scenario_id, "policy_renewal");
  assert.equal(result.router, undefined); // validateDecision keeps only the gateway contract fields
});

test("PythonProvider rejects unknown ids, HTTP errors and an unreachable router", async () => {
  const config = getConfig({ ROUTER_MODE: "python" });
  reply.calls = [];
  await assert.rejects(new PythonProvider(config, reply({ ...decision, scenario_id: "invented" })).route({ text: "x", catalog, session: createSession() }), { code: "invalid_model_output" });
  await assert.rejects(new PythonProvider(config, reply({ detail: "boom" }, 502)).route({ text: "x", catalog, session: createSession() }), { code: "upstream_error" });
  const down = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(new PythonProvider(config, down).route({ text: "x", catalog, session: createSession() }), { code: "router_unavailable", status: 502 });
  await assert.rejects(new PythonProvider(config, reply(decision)).transcribe(new Int16Array(4)), { code: "voice_disabled" });
});

test("gateway engine runs a full turn with the Python decision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tynda-test-"));
  reply.calls = [];
  const config = { ...getConfig({ ROUTER_MODE: "python" }), dataDir: directory };
  const app = await createBackend({ config, provider: new PythonProvider(config, reply(decision)) });
  try {
    const events = [];
    const result = await app.engine.run(createSession(), { text: "Полисімді продлить керек" }, e => events.push(e));
    assert.equal(result.decision.scenario_id, "policy_renewal");
    assert.equal(result.mode, "python");
    const routed = events.find(e => e.type === "route_decision");
    assert.equal(routed.path, "llm");
    assert.equal(routed.source, "python");
    assert.ok(events.some(e => e.type === "trace" && e.timings_ms.route >= 0));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
