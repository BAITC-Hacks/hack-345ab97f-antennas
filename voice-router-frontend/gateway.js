/**
 * Transport boundary for the frontend. The production Gateway owns routing,
 * speech providers and trace persistence; this file never selects scenarios.
 */
export class VoiceRouterGateway {
  constructor({ url, onEvent, onStatus }) {
    this.url = url;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.socket = null;
  }

  connect() {
    if (!this.url) {
      this.onStatus({ mode: "demo", text: "demo gateway" });
      return;
    }
    this.onStatus({ mode: "connecting", text: "gateway connecting" });
    try { this.socket = new WebSocket(this.url); }
    catch { this.onStatus({ mode: "offline", text: "gateway unavailable" }); return; }
    this.socket.addEventListener("open", () => this.onStatus({ mode: "online", text: "gateway online" }));
    this.socket.addEventListener("close", () => this.onStatus({ mode: "offline", text: "gateway offline" }));
    this.socket.addEventListener("error", () => this.onStatus({ mode: "offline", text: "gateway error" }));
    this.socket.addEventListener("message", (event) => {
      let payload;
      try { payload = JSON.parse(event.data); }
      catch { this.onEvent({ type: "transport_error", message: "Gateway sent invalid JSON" }); return; }
      if (!payload || typeof payload !== "object" || typeof payload.type !== "string") return;
      this.onEvent(payload);
    });
  }

  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 262144) {
      this.socket.send(JSON.stringify(payload));
      return true;
    }
    if (payload.type !== "audio_chunk") this.onEvent({ type: "transport_error", message: "Нет подключения к Gateway или канал перегружен." });
    return false;
  }

  close() { this.socket?.close(); }
}

export function parseGatewayUrl() {
  const candidate = new URLSearchParams(location.search).get("gateway");
  try {
    const url = new URL(candidate);
    return ["ws:", "wss:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
