import test from "node:test";
import assert from "node:assert/strict";
import { createAppServer, extractOutputText, loadDotEnv } from "../server.mjs";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

async function withServer(options, fn) {
  const server = createAppServer({ env: {}, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const post = (url, text, extra = {}) => fetch(url + "/api/route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), ...extra });
const fakeKey = "test-only-not-a-real-key";

test("dotenv loads beside the file and preserves explicit environment", () => {
  const env = { OPENAI_MODEL: "from-shell" };
  loadDotEnv(fileURLToPath(new URL("./fixtures/", import.meta.url)), env, ".env.fixture");
  assert.equal(env.OPENAI_API_KEY, fakeKey);
  assert.equal(env.OPENAI_MODEL, "from-shell");
  assert.equal(env.PORT, "8799");
  assert.equal(env.UNRELATED, undefined);
});
test("extracts REST text after reasoning items and skips non-text parts", () => {
  assert.equal(extractOutputText({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "Сәлем" }, { type: "refusal", refusal: "x" }, { type: "output_text", text: "Здравствуйте" }] }] }), "Сәлем\nЗдравствуйте");
  assert.equal(extractOutputText({}), "");
});
test("serves only public assets, even outside project cwd", async () => withServer({}, async url => {
  for (const path of ["/", "/index.html", "/styles.css", "/app.js", "/gateway.js"]) assert.equal((await fetch(url + path)).status, 200);
  for (const path of ["/.env", "/.env.example", "/.git/config", "/server.mjs", "/package.json", "/test/fixtures/.env", "/%2e%2e/server.mjs"]) assert.equal((await fetch(url + path)).status, 404);
  const head = await fetch(url, { method: "HEAD" }); assert.equal(await head.text(), "");
}));
test("no key: health is safe and API reports configuration error", async () => withServer({}, async url => {
  assert.deepEqual(await (await fetch(url + "/api/health")).json(), { ok: true, openaiConfigured: false });
  const response = await post(url, "Hello"); assert.equal(response.status, 503); assert.equal((await response.json()).error, "not_configured");
}));
test("validates JSON, text, content type, method and payload size", async () => withServer({}, async url => {
  for (const value of [null, {}, 42, "", " ", "a".repeat(601)]) assert.equal((await post(url, value)).status, 400);
  assert.equal((await post(url, "x", { body: "{" })).status, 400);
  assert.equal((await post(url, "x", { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await fetch(url + "/api/route")).status, 405);
  assert.equal((await post(url, "a".repeat(9000))).status, 413);
}));
test("rejects foreign browser origins and DNS-rebinding hosts", async () => withServer({}, async url => {
  assert.equal((await post(url, "x", { headers: { Origin: "https://example.invalid", "Content-Type": "application/json" } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request(url, { headers: { Host: "example.invalid" } }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject); req.end();
  });
  assert.equal(status, 403);
}));
test("passes key only upstream and returns REST output text", async () => {
  let calls = 0;
  await withServer({ env: { OPENAI_API_KEY: fakeKey }, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options.headers.Authorization, `Bearer ${fakeKey}`);
    assert.equal(JSON.parse(options.body).store, false);
    return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "Ответ" }] }] });
  } }, async url => {
    const response = await post(url, "Привет"); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "Ответ", mode: "smoke-test" });
    assert.equal((await (await fetch(url + "/api/health")).text()).includes(fakeKey), false);
  });
  assert.equal(calls, 1);
});
test("upstream errors are sanitized, not leaked to browser", async () => {
  for (const [status, code] of [[401, "api_auth"], [429, "api_limit"], [500, "upstream_error"]]) {
    await withServer({ env: { OPENAI_API_KEY: fakeKey }, fetchImpl: async () => Response.json({ error: { message: fakeKey } }, { status }) }, async url => {
      const response = await post(url, "x"); assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: code });
    });
  }
});
test("timeout and empty response are distinguishable", async () => {
  await withServer({ env: { OPENAI_API_KEY: fakeKey }, fetchImpl: async () => { throw new DOMException("timeout", "TimeoutError"); } }, async url => assert.equal((await post(url, "x")).status, 504));
  await withServer({ env: { OPENAI_API_KEY: fakeKey }, fetchImpl: async () => Response.json({ output: [] }) }, async url => assert.equal((await (await post(url, "x")).json()).error, "empty_response"));
});
