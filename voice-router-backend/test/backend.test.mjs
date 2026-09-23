import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import WebSocket from "ws";
import { createBackend } from "../src/server.mjs";
import { getConfig } from "../src/config.mjs";
import { Store } from "../src/store.mjs";
import { OpenAIProvider, DemoProvider } from "../src/provider.mjs";
import { validateDecision, scenarioInput } from "../src/validation.mjs";
import { AudioBuffer, decodePcm, pcmToWav } from "../src/audio.mjs";
import { createSession, Engine } from "../src/gateway.mjs";

const example = { id: "new_example", title: "Тестовый сценарий", purpose: "Тест", boundary: "Не платёж", ru: "Проверочный запрос", kk: "Сынақ сұрағы" };
async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), "tynda-test-"));
  try { return await fn(directory); }
  finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "tynda-test-"));
    await rm(directory, { recursive: true, force: true });
  }
}
async function backend(fn, overrides = {}) {
  await temporary(async directory => {
    const config = { ...getConfig({}), dataDir: directory, ...overrides.config };
    const app = await createBackend({ config, provider: overrides.provider });
    await app.listen(0);
    try { await fn(app, `http://127.0.0.1:${app.server.address().port}`); }
    finally { await app.close(); }
  });
}
const post = (url, body, options = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...options });
function openSocket(base, options) {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", options);
  const messages = [], waiters = [];
  ws.on("message", data => {
    const message = JSON.parse(data);
    messages.push(message);
    for (const waiter of [...waiters]) if (waiter.match(message)) { clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter),1); waiter.resolve(message); }
  });
  ws.next = (match, since = messages.length) => {
    const found = messages.slice(since).find(match); if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      waiter.timer = setTimeout(() => { waiters.splice(waiters.indexOf(waiter),1); reject(new Error("WebSocket event timeout")); }, 3000);
      waiters.push(waiter);
    });
  };
  ws.messages = messages;
  return ws;
}
async function turn(ws, text) {
  const since = ws.messages.length;
  ws.send(JSON.stringify({ type: "text_input", text }));
  await ws.next(e => e.type === "trace", since);
  return ws.messages.slice(since);
}

test("config is explicitly demo by default; OpenAI requires a key", () => {
  assert.equal(getConfig({ OPENAI_API_KEY: "unused-test-key" }).mode, "demo");
  assert.throws(() => getConfig({ ROUTER_MODE: "openai" }), /required/);
  assert.throws(() => getConfig({ PORT: "-2" }), /PORT/);
  assert.throws(() => getConfig({ FRONTEND_ORIGINS: "https://evil.example" }), /loopback/);
});
test("HTTP serves frontend and denies backend secrets and foreign origins", async () => backend(async (app, base) => {
  assert.equal((await (await fetch(base + "/api/health")).json()).mode, "demo");
  assert.match((await fetch(base, { redirect: "manual" })).headers.get("location"), /gateway=/);
  for (const asset of ["/index.html","/app.js","/styles.css","/gateway.js"]) assert.equal((await fetch(base + asset)).status, 200);
  for (const path of ["/.env","/src/server.mjs","/data/state.json","/../package.json","/node_modules/ws/index.js"]) assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + "/api/catalog", { headers: { Origin: "https://evil.example" } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request(base + "/api/health", { headers: { Host: "evil.example" } }, res => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end();
  });
  assert.equal(status, 403);
}));
test("HTTP validates text, JSON, content type, body size and pagination", async () => backend(async (app, base) => {
  for (const value of ["", "x".repeat(601), null, 42]) assert.equal((await post(base + "/api/route", { text: value })).status, 400);
  assert.equal((await post(base + "/api/route", {}, { body: "{" })).status, 400);
  assert.equal((await post(base + "/api/route", {}, { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await post(base + "/api/catalog", { a: "x".repeat(33000) })).status, 413);
  assert.equal((await fetch(base + "/api/traces?limit=-1")).status, 400);
}));
test("catalog CRUD persists and serializes simultaneous writes", async () => temporary(async directory => {
  let store = await new Store(directory).init();
  const count = store.catalog().scenarios.length;
  await Promise.all([store.upsert(example), store.upsert({ ...example, id: "second_example" })]);
  assert.equal(store.catalog().scenarios.length, count + 2);
  await store.close();
  store = await new Store(directory).init();
  try {
    assert.equal(store.catalog().scenarios.find(s => s.id === example.id).title, example.title);
    await store.deleteScenario(example.id);
    assert.equal(store.catalog().scenarios.some(s => s.id === example.id), false);
    assert.throws(() => scenarioInput({ ...example, id: "../secret" }));
  } finally { await store.close(); }
}));
test("same storage cannot be opened by two servers; corrupt data is preserved", async () => temporary(async directory => {
  const store = await new Store(directory).init();
  await assert.rejects(() => new Store(directory).init(), /locked/);
  await store.close();
  const invalid = "{broken";
  await writeFile(join(directory, "state.json"), invalid);
  await assert.rejects(() => new Store(directory).init());
  assert.equal(await readFile(join(directory, "state.json"), "utf8"), invalid);
}));
test("WebSocket contract: session, catalog, ordered turn, actual timings and isolated sessions", async () => backend(async (app, base) => {
  const ws = openSocket(base); await once(ws, "open");
  await ws.next(e => e.type === "catalog_snapshot", 0);
  const events = await turn(ws, "Төлемім неге өтпей қалды?");
  assert.deepEqual(events.filter(e => ["transcript","route_decision","response_text","trace"].includes(e.type)).map(e => e.type), ["transcript","route_decision","response_text","trace"]);
  const decision = events.find(e => e.type === "route_decision");
  assert.equal(decision.scenario_id, "payment_failed"); assert.equal(decision.source, "demo"); assert.equal(decision.language, "kk");
  const trace = events.find(e => e.type === "trace"); assert.ok(trace.timings_ms.total >= trace.timings_ms.route); assert.equal(trace.timings_ms.first_audio, undefined);
  const other = openSocket(base); await once(other, "open");
  assert.notEqual(ws.messages.find(e => e.type === "session_open").session_id, (await other.next(e => e.type === "session_open", 0)).session_id);
  ws.close(); other.close();
}));
test("clarify escalates after two questions and persists a local handoff", async () => backend(async (app, base) => {
  const ws = openSocket(base); await once(ws, "open");
  for (const expected of ["clarify","clarify","handoff"]) {
    const events = await turn(ws, "Непонятный вопрос для демо");
    assert.equal(events.find(e => e.type === "route_decision").decision, expected);
  }
  const queue = await (await fetch(base + "/api/handoffs")).json();
  assert.equal(queue.items.length, 1); assert.ok(queue.items[0].history.length >= 4);
  const response = await post(base + "/api/handoffs/" + queue.items[0].id, { status: "closed" }, { method: "PATCH" });
  assert.equal((await response.json()).status, "closed");
  ws.close();
}));
test("new catalog example is routed on the next call without restart", async () => backend(async (app, base) => {
  const ws = openSocket(base); await once(ws, "open");
  let since = ws.messages.length;
  ws.send(JSON.stringify({ type: "catalog_upsert", scenario: example }));
  assert.equal((await ws.next(e => e.type === "catalog_updated", since)).scenario_id, example.id);
  const events = await turn(ws, example.ru);
  assert.equal(events.find(e => e.type === "route_decision").scenario_id, example.id);
  since = ws.messages.length;
  ws.send(JSON.stringify({ type: "catalog_delete", scenario_id: example.id }));
  await ws.next(e => e.type === "catalog_deleted", since);
  const catalog = await (await fetch(base + "/api/catalog")).json();
  assert.equal(catalog.scenarios.some(s => s.id === example.id), false);
  ws.close();
}));
test("WebSocket malformed packets are rejected without disconnecting", async () => backend(async (app, base) => {
  const ws = openSocket(base); await once(ws, "open");
  for (const data of ["{","null",JSON.stringify({ type: "unknown" }),JSON.stringify({ type: "text_input", text: {} })]) {
    const since = ws.messages.length; ws.send(data); await ws.next(e => e.type === "transport_error", since);
  }
  assert.equal((await turn(ws, "Не могу оплатить полис")).find(e => e.type === "route_decision").scenario_id, "payment_failed");
  ws.close();
}));
test("WebSocket rejects foreign Origin", async () => backend(async (app, base) => {
  const ws = new WebSocket(base.replace("http:","ws:") + "/ws", { origin: "https://evil.example" });
  const error = await once(ws, "error");
  assert.match(error[0].message, /403/);
}));
test("audio validates base64/sample rate, creates WAV and caps silence", () => {
  assert.throws(() => decodePcm("bad",16000));
  assert.throws(() => decodePcm("AAAA",48000));
  assert.throws(() => decodePcm("AAAA",16000));
  const pcm = Buffer.alloc(3200);
  for (let i=0; i<pcm.length; i+=2) pcm.writeInt16LE(4000,i);
  const decoded = decodePcm(pcm.toString("base64"),16000);
  assert.equal(pcmToWav(decoded).readUInt32LE(24),16000);
  assert.equal(pcmToWav(decoded).readUInt32LE(40),pcm.length);
  const buffer = new AudioBuffer();
  for (let i=0;i<200;i++) buffer.push(Buffer.alloc(4096));
  assert.equal(buffer.bytes,0); assert.ok(buffer.preRoll.length <= 6400);
  buffer.push(pcm); assert.ok(buffer.take().length > 0); assert.equal(buffer.take(),null);
  assert.throws(() => { for(let i=0;i<301;i++) buffer.push(pcm); }, /30 секунд/);
});
test("voice pipeline emits playable TTS using mocked provider; raw audio is not persisted", async () => {
  const demo = new DemoProvider();
  const provider = {
    route: input => demo.route(input),
    transcribe: async pcm => { assert.ok(pcm.length > 0); return "Не могу оплатить полис"; },
    synthesize: async () => Buffer.from("FAKE-MP3"),
  };
  await backend(async (app, base) => {
    const ws = openSocket(base); await once(ws, "open");
    const pcm = Buffer.alloc(4096); for (let i=0;i<pcm.length;i+=2) pcm.writeInt16LE(3000,i);
    const since = ws.messages.length;
    ws.send(JSON.stringify({ type:"audio_chunk", sample_rate_hz:16000, pcm16:pcm.toString("base64") }));
    ws.send(JSON.stringify({ type:"speech_end" }));
    await ws.next(e => e.type === "trace", since);
    const events = ws.messages.slice(since);
    assert.equal(events.find(e => e.type === "tts_audio").mime_type,"audio/mpeg");
    assert.equal(events.find(e => e.type === "tts_audio").ai_generated,true);
    assert.equal(JSON.stringify(app.store.traces()).includes("FAKE-MP3"),false);
    ws.close();
  }, { provider, config: { voiceEnabled: true } });
});
test("OpenAI adapter sends strict schema, no key in body, and reads REST output", async () => backend(async app => {
  const catalog = app.store.catalog().scenarios;
  const decision = await new DemoProvider().route({ text:"Не могу оплатить полис", catalog });
  const key = "not-a-real-key";
  const provider = new OpenAIProvider({ ...getConfig({}), apiKey:key }, async (url, options) => {
    assert.equal(url,"https://api.openai.com/v1/responses");
    assert.equal(options.headers.Authorization,"Bearer " + key);
    const body = JSON.parse(options.body);
    assert.equal(body.text.format.strict,true); assert.equal(body.store,false);
    assert.equal(options.body.includes(key),false);
    return Response.json({ status:"completed", output:[{ type:"reasoning" },{ type:"message",content:[{type:"output_text",text:JSON.stringify(decision)}] }] });
  });
  const result = await provider.route({ text:"x",catalog,session:createSession() });
  assert.equal(result.scenario_id,"payment_failed");
  assert.throws(() => validateDecision({...result,scenario_id:"invented_id"},catalog));
  assert.throws(() => validateDecision({...result,confidence:2},catalog));
}));
test("OpenAI refusal, timeout and upstream authentication errors are safe", async () => backend(async app => {
  const catalog = app.store.catalog().scenarios, input = { text:"x",catalog,session:createSession() };
  for (const [fetchImpl,code] of [
    [async () => Response.json({error:{message:"private-token"}},{status:401}),"api_auth"],
    [async () => Response.json({status:"completed",output:[{type:"message",content:[{type:"refusal",refusal:"no"}]}]}),"invalid_model_output"],
    [async () => { throw new DOMException("private-token","TimeoutError"); },"timeout"],
  ]) {
    const provider = new OpenAIProvider({...getConfig({}),apiKey:"test"},fetchImpl);
    await assert.rejects(() => provider.route(input), error => error.code === code && !error.message.includes("private-token"));
  }
}));
test("OpenAI speech adapters submit WAV multipart and receive MP3", async () => {
  const calls = [];
  const provider = new OpenAIProvider({...getConfig({}),apiKey:"test"}, async (url,options) => {
    calls.push(url);
    if (url.endsWith("transcriptions")) {
      assert.equal(options.headers["Content-Type"],undefined);
      const bytes = Buffer.from(await options.body.get("file").arrayBuffer());
      assert.equal(bytes.toString("ascii",0,4),"RIFF");
      return Response.json({text:"Сәлем"});
    }
    assert.equal(JSON.parse(options.body).response_format,"mp3");
    return new Response(Buffer.from("mp3"));
  });
  assert.equal(await provider.transcribe(Buffer.alloc(100)),"Сәлем");
  assert.equal((await provider.synthesize("Сәлем")).toString(),"mp3"); assert.equal(calls.length,2);
});
test("concurrent turn is rejected and provider failure still completes a trace", async () => backend(async (app,base) => {
  let release;
  const provider = { route: async () => { await new Promise(resolve => { release = resolve; }); throw new Error("private detail"); } };
  const engine = new Engine({store:app.store,config:app.engine.config,provider});
  const session = createSession(), events = [];
  const pending = engine.run(session,{text:"hello"},event => events.push(event));
  await assert.rejects(() => engine.run(session,{text:"second"}),error => error.code === "busy");
  release(); await assert.rejects(() => pending);
  assert.equal(events.at(-1).type,"trace"); assert.equal(session.busy,false); assert.equal(engine.active,0);
  assert.equal(JSON.stringify(events).includes("private detail"),false);
}));
test("supervisor metrics never pretend to know accuracy and separate modes", async () => backend(async (app,base) => {
  await post(base + "/api/route",{text:"Не могу оплатить полис"});
  const stats = await (await fetch(base + "/api/supervisor")).json();
  assert.equal(stats.sample_size,1); assert.equal(stats.accuracy,null); assert.ok(stats.routing_p50_ms >= 0);
  assert.equal(app.store.metrics("openai").sample_size,0);
}));
