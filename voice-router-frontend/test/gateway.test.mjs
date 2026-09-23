import test from "node:test";
import assert from "node:assert/strict";
import { VoiceRouterGateway, parseGatewayUrl } from "../gateway.js";

test("Gateway URL accepts only ws/wss without embedded credentials", () => {
  for (const [value, expected] of [["ws://localhost:8000/ws", "ws://localhost:8000/ws"], ["wss://example.test/ws", "wss://example.test/ws"], ["https://example.test", null], ["ws://user:secret@example.test", null], ["broken", null]]) {
    globalThis.location = { search: `?gateway=${encodeURIComponent(value)}` };
    assert.equal(parseGatewayUrl(), expected);
  }
  delete globalThis.location;
});
test("no URL stays in demo without opening a connection", () => {
  let status;
  const gateway = new VoiceRouterGateway({ url: null, onEvent() {}, onStatus(value) { status = value; } });
  gateway.connect(); assert.equal(status.mode, "demo"); assert.equal(gateway.socket, null);
});
test("transport validates messages and bounds audio buffering", () => {
  const original = globalThis.WebSocket;
  class FakeSocket {
    static OPEN = 1;
    readyState = 1; bufferedAmount = 0; listeners = {}; sent = [];
    addEventListener(name, callback) { this.listeners[name] = callback; }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeSocket;
  try {
    const events = [], statuses = [];
    const gateway = new VoiceRouterGateway({ url: "ws://localhost/ws", onEvent: event => events.push(event), onStatus: status => statuses.push(status) });
    gateway.connect(); assert.equal(statuses[0].mode, "connecting");
    const socket = gateway.socket;
    socket.listeners.open(); assert.equal(statuses.at(-1).mode, "online");
    socket.listeners.message({ data: "{" }); assert.equal(events.at(-1).type, "transport_error");
    socket.listeners.message({ data: "null" }); assert.equal(events.length, 1);
    socket.listeners.message({ data: '{"type":"transcript","text":"Привет"}' }); assert.equal(events.at(-1).text, "Привет");
    assert.equal(gateway.send({ type: "text_input", text: "x" }), true);
    socket.bufferedAmount = 262144;
    assert.equal(gateway.send({ type: "audio_chunk", pcm16: "AAAA" }), false);
    assert.equal(events.length, 2); // Dropped audio must not flood the toast with errors.
    gateway.close(); assert.equal(gateway.send({ type: "text_input", text: "x" }), false);
  } finally { globalThis.WebSocket = original; }
});
