import { VoiceRouterGateway, parseGatewayUrl } from "./gateway.js";

const demos = {
  payment: { turn: "#043", text: "Я вчера оплатил, деньги списались, а заказ не подтвердился. И адрес надо поменять.", lang: "ru", scenario: "payment_not_confirmed", label: "Проблема с подтверждением оплаты", confidence: 0.86, decision: "route", additional: "change_delivery_address · 0.81", response: "Вижу оплату за вчера. Проверю подтверждение заказа. После этого вернёмся к изменению адреса.", reason: "Списаны деньги, но заказ не подтверждён. Второй запрос сохранён в очередь.", timings: [["Endpoint", 22], ["STT", 181], ["LLM router", 384], ["Scenario executor", 94], ["First audio", 147]], path: "llm", events: ["VAD: конец реплики", "STT: финальный transcript (ru)", "LLM: route · payment_not_confirmed", "Executor: платёж в проверке", "TTS: первый аудиофрагмент"] },
  kazakh: { turn: "#044", text: "Төлемім неге өтпей қалды?", lang: "kk", scenario: "payment_failed", label: "Не прошла оплата", confidence: 0.91, decision: "route", additional: "Нет дополнительного намерения", response: "Төлем әрекеті сәтсіз аяқталғанын көріп тұрмын. Қайта төлеудің қауіпсіз жолын тексерейін.", reason: "Клиент спрашивает о неуспешной оплате, а не о списании без подтверждения.", timings: [["Endpoint", 18], ["STT", 196], ["LLM router", 351], ["Scenario executor", 81], ["First audio", 138]], path: "llm", events: ["VAD: конец реплики", "STT: финальный transcript (kk)", "LLM: route · payment_failed", "TTS: первый аудиофрагмент"] },
  mixed: { turn: "#045", text: "Полисімді продлить керек, бірақ бағасын да айтыңызшы.", lang: "mixed", scenario: "policy_renewal", label: "Продление полиса", confidence: 0.89, decision: "route", additional: "quote_policy_price · 0.76", response: "Полисті ұзартуға көмектесемін. Алдымен мерзімін тексеремін, содан кейін құнын айтамын.", reason: "Основной запрос: продление. Вопрос о стоимости привязан к тому же сценарию.", timings: [["Endpoint", 20], ["STT", 213], ["LLM router", 409], ["Scenario executor", 88], ["First audio", 145]], path: "llm", events: ["VAD: конец реплики", "STT: финальный transcript (mixed)", "LLM: route · policy_renewal", "Executor: проверка полиса", "TTS: первый аудиофрагмент"] },
  ambiguous: { turn: "#046", text: "Хочу отменить операцию.", lang: "ru", scenario: "payment_cancel_or_refund", label: "Уточнение: отмена или возврат", confidence: 0.58, decision: "clarify", additional: "Топ-2: payment_cancel, refund_request", response: "Уточните, пожалуйста: отменить ещё не завершённую оплату или вернуть деньги за уже совершённую?", reason: "Фраза подходит к двум соседним сценариям. Роутер не угадывает и задаёт уточняющий вопрос.", timings: [["Endpoint", 20], ["STT", 165], ["LLM router", 338], ["Clarify", 36], ["First audio", 131]], path: "llm", events: ["VAD: конец реплики", "STT: финальный transcript (ru)", "LLM: clarify · top-2 candidates", "TTS: уточняющий вопрос"] }
};

const $ = (query) => document.querySelector(query);
const gatewayUrl = parseGatewayUrl();
let selected = null, callActive = false, mediaStream = null, audioContext = null, quietTimer = null, turnCounter = 46, pendingTurn = null;
let requestController = null, editingId = null, showAllRoutes = false, toastTimer;
const history = new Map();
for (const [name, turn] of Object.entries(demos)) {
  turn.path = "demo";
  turn.source = "demo";
  turn.additional_intents = name === "payment" ? [{ scenario_id: "change_delivery_address", confidence: 0.81 }] : name === "mixed" ? [{ scenario_id: "quote_policy_price", confidence: 0.76 }] : [];
  turn.alternatives = name === "ambiguous" ? ["payment_cancel", "refund_request"] : [];
  if (name === "ambiguous") turn.scenario = null;
}
let catalog = loadCatalog();
const gateway = new VoiceRouterGateway({ url: gatewayUrl, onEvent: receiveGatewayEvent, onStatus: setGatewayStatus });
gateway.connect();

function setNav() {
  const page = ["call", "trace", "supervisor", "catalog"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "call";
  document.querySelectorAll(".page").forEach((node) => node.classList.toggle("active", node.id === page));
  document.querySelectorAll(".nav-link").forEach((node) => {
    node.classList.toggle("active", node.dataset.page === page);
    if (node.dataset.page === page) node.setAttribute("aria-current", "page"); else node.removeAttribute("aria-current");
  });
  $("#page-kicker").textContent = $("#" + page).dataset.kicker;
}
window.addEventListener("hashchange", setNav); setNav();
function setGatewayStatus({ mode, text }) {
  const indicator = $("#gateway-status");
  indicator.className = `pill ${mode === "online" ? "live" : ""}`;
  indicator.textContent = text;
  if (mode === "offline" && callActive) stopMicrophone();
}
function fmt(milliseconds) { return `${String(Math.round(milliseconds)).padStart(3, "0")} ms`; }
function totalOf(timings = []) { return timings.reduce((sum, [, value]) => sum + Number(value || 0), 0); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]); }
function toast(message) { const node = $("#toast"); node.textContent = message; node.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove("show"), 4000); }

function showTurn(turn) { selected = turn; $("#turn-id").textContent = turn.turn; $("#client-text").textContent = turn.text || "Реплика получена"; $("#bot-text").textContent = turn.response || "Роутер обрабатывает запрос."; $("#route-name").textContent = turn.label || turn.scenario || "ожидание решения"; $("#route-confidence").textContent = Number.isFinite(turn.confidence) ? `${Math.round(turn.confidence * 100)}% · ${turn.decision}` : "маршрут ожидается"; renderTrace(turn); appendRoute(turn); }
function useDemo(name) { cancelRequest(); stopMicrophone(); pendingTurn = null; showTurn(demos[name]); window.location.hash = "call"; toast("Демо: заранее подготовленный результат, без вызова модели"); }
document.querySelectorAll(".prompt").forEach((button) => button.addEventListener("click", () => useDemo(button.dataset.demo)));

function renderTrace(turn) {
  const timings = (turn.timings || []).filter((item) => Array.isArray(item) && Number.isFinite(item[1]) && item[1] >= 0);
  const duration = totalOf(timings), total = Number.isFinite(turn.total) ? turn.total : duration;
  $("#trace-total").textContent = total ? `${total} ms` : "ожидание";
  $("#trace-subtitle").textContent = `${turn.turn || "#---"} · ${turn.source === "demo" ? "синтетический пример · " : ""}${turn.decision || "ожидание"}`;
  const scale = Math.max(duration, total, 1);
  let offset = 0;
  $("#waterfall").className = timings.length ? "waterfall" : "waterfall empty";
  $("#waterfall").innerHTML = timings.length ? timings.map(([name, ms]) => {
    const start = offset; offset += ms;
    return `<div class="waterfall-row"><span>${escapeHtml(name)}</span><i title="${start}–${offset} ms"><b style="margin-left:${start / scale * 100}%;width:${ms / scale * 100}%"></b></i><strong>${fmt(ms)}</strong></div>`;
  }).join("") : "<p>Gateway ещё не прислал trace.</p>";
  $(".waterfall-axis").innerHTML = [0, .25, .5, .75, 1].map((x) => `<span>${Math.round(x * scale)} ms</span>`).join("");
  $("#decision-path").textContent = (turn.path || "pending").toUpperCase();
  $("#trace-transcript").textContent = turn.text ? `«${turn.text}»` : "—";
  $("#trace-language").textContent = `Язык: ${turn.lang || "ожидание"}`;
  $("#trace-reason").textContent = turn.reason || "Gateway ещё не вернул обоснование.";
  $("#additional-intent").textContent = turn.additional || renderAdditional(turn.additional_intents);
  $("#json-output").textContent = JSON.stringify({
    scenario_id: turn.scenario || null, decision: turn.decision || "pending",
    confidence: turn.confidence ?? null, additional_intents: turn.additional_intents || [],
    alternatives: turn.alternatives || [], language: turn.lang || null,
    reason: turn.reason || null, source: turn.source || turn.path || "pending",
  }, null, 2);
  $("#trace-turn-status").textContent = turn.decision || "ожидание";
  $("#trace-events").innerHTML = (turn.events || ["Gateway ждёт новую реплику клиента."]).map((event) => `<li>${escapeHtml(event)}</li>`).join("");
}
function appendRoute(turn) {
  if (!["route", "clarify", "handoff"].includes(turn.decision)) return;
  const key = turn.historyKey || turn.turn;
  history.set(key, { ...turn, time: history.get(key)?.time || new Date().toLocaleTimeString("ru-RU") });
  if (history.size > 100) history.delete(history.keys().next().value);
  renderHistory();
}
function renderHistory() {
  const records = [...history.values()].reverse();
  $("#recent-routes").innerHTML = (showAllRoutes ? records : records.slice(0, 4)).map((turn) =>
    `<tr><td>${escapeHtml(turn.time)}</td><td>${escapeHtml(turn.scenario || "—")}</td><td>${escapeHtml(turn.decision)}${turn.source === "demo" ? " · demo" : ""}</td><td>${turn.total || totalOf(turn.timings) || "—"}</td></tr>`
  ).join("") || '<tr><td colspan="4">В этой сессии пока нет решений</td></tr>';
}
function cancelRequest() {
  requestController?.abort(); requestController = null;
  $("#text-input-form button").disabled = false;
}

function resetDemo() { cancelRequest(); stopMicrophone(); selected = null; pendingTurn = null; history.clear(); renderHistory(); $("#turn-id").textContent = "#042"; $("#client-text").textContent = "Выберите фразу ниже, чтобы начать."; $("#bot-text").textContent = "Я покажу маршрут, альтернативы и задержку каждого этапа."; $("#route-name").textContent = "ожидание ввода"; $("#route-confidence").textContent = "—"; renderTrace({}); toast("Демо сброшено"); }
$("#reset-demo").addEventListener("click", resetDemo); $("#replay-trace").addEventListener("click", () => selected ? renderTrace(selected) : toast("Сначала отправьте реплику")); $("#gateway-mode").addEventListener("click", () => toast(gatewayUrl ? `Подключён Gateway: ${gatewayUrl}` : "Для live Gateway откройте ?gateway=ws://localhost:<порт>/ws"));

$("#text-input-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#text-input"), text = input.value.trim();
  if (!text || requestController) return;
  if (gatewayUrl) {
    if (gateway.socket?.readyState !== 1) { toast("Gateway не подключён. Реплика не отправлена."); return; }
    beginGatewayTurn(text);
    gateway.send({ type: "text_input", text, client_ts: Date.now() });
    input.value = "";
  } else {
    input.value = "";
    await callOpenAISmokeTest(text);
  }
});

async function toggleMicrophone() {
  if (callActive) { stopMicrophone(); return; }
  if (!gatewayUrl || gateway.socket?.readyState !== 1) { toast("Для голосового ввода нужен подключённый Gateway. Демо-реплики доступны ниже."); return; }
  $("#call-button").disabled = true;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (gateway.socket?.readyState !== 1) throw new Error("Gateway disconnected");
    await streamPcm16(mediaStream);
    callActive = true;
    $("#voice-orb").classList.add("active");
    $("#voice-orb").setAttribute("aria-label", "Микрофон включён");
    $("#call-button").innerHTML = '<span class="mic-icon">●</span> Завершить звонок';
    $("#call-state").textContent = "Слушаю · PCM16 mono 16 kHz → Gateway";
  } catch {
    stopMicrophone();
    toast("Микрофон или аудиоканал недоступен. Используйте текстовый ввод.");
  } finally { $("#call-button").disabled = false; }
}
$("#call-button").addEventListener("click", toggleMicrophone);
function stopMicrophone() {
  clearTimeout(quietTimer); quietTimer = null;
  const wasActive = callActive;
  mediaStream?.getTracks().forEach((track) => track.stop());
  audioContext?.close().catch(() => {});
  mediaStream = null; audioContext = null; callActive = false;
  $("#voice-orb").classList.remove("active");
  $("#voice-orb").setAttribute("aria-label", "Микрофон выключен");
  $("#call-button").innerHTML = '<span class="mic-icon">●</span> Начать звонок';
  $("#call-state").textContent = "Микрофон выключен · текстовый канал доступен";
  if (wasActive && gateway.socket?.readyState === 1) gateway.send({ type: "speech_end", client_ts: Date.now() });
}
async function streamPcm16(stream) {
  audioContext = new AudioContext({ sampleRate: 16000 });
  await audioContext.resume();
  if (audioContext.sampleRate !== 16000) throw new Error("16 kHz not supported");
  const source = audioContext.createMediaStreamSource(stream), processor = audioContext.createScriptProcessor(2048, 1, 1);
  let speaking = false;
  source.connect(processor); processor.connect(audioContext.destination);
  processor.onaudioprocess = (event) => {
    if (!callActive) return;
    const samples = event.inputBuffer.getChannelData(0);
    const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    if (rms > 0.015) {
      if (!speaking && !pendingTurn) beginGatewayTurn("");
      speaking = true; clearTimeout(quietTimer); quietTimer = null;
    }
    if (speaking && rms <= 0.015 && !quietTimer) quietTimer = setTimeout(() => {
      gateway.send({ type: "speech_end", client_ts: Date.now() }); speaking = false; quietTimer = null;
    }, 700);
    if (!gateway.send({ type: "audio_chunk", pcm16: pcm16Base64(samples), sample_rate_hz: 16000 })) {
      stopMicrophone(); toast("Аудиоканал перегружен или отключён. Звонок остановлен.");
    }
  };
}
window.addEventListener("pagehide", () => { cancelRequest(); stopMicrophone(); gateway.close(); });

function pcm16Base64(samples) { const bytes = new Uint8Array(samples.length * 2); samples.forEach((sample, index) => { const value = Math.max(-1, Math.min(1, sample)) * 0x7fff; bytes[index * 2] = value & 255; bytes[index * 2 + 1] = (value >> 8) & 255; }); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }

function beginGatewayTurn(text) { pendingTurn = { turn: `#${String(++turnCounter).padStart(3, "0")}`, text, lang: "pending", scenario: null, label: "роутер обрабатывает", decision: "pending", confidence: null, additional: "Ожидаем route_decision", response: "Распознаём и маршрутизируем реплику.", reason: "Gateway обрабатывает запрос.", timings: [], path: "gateway", events: ["Frontend: текст отправлен в Gateway"] }; showTurn(pendingTurn); }
async function callOpenAISmokeTest(text) {
  const controller = new AbortController();
  requestController = controller;
  $("#text-input-form button").disabled = true;
  const turn = { turn: `#${++turnCounter}`, text, lang: "—", scenario: null, label: "OpenAI · проверка подключения", decision: "pending", confidence: null, response: "Ожидаем ответ серверного proxy.", reason: "Ключ остаётся на сервере. Это не выбор сценария.", timings: [], path: "server", events: ["Frontend: запрос отправлен в локальный proxy"] };
  showTurn(turn);
  const errors = {
    not_configured: "Ключ не настроен. Добавьте новый OPENAI_API_KEY в серверный .env и перезапустите сервер.",
    api_auth: "OpenAI отклонил ключ или доступ к модели. Проверьте серверные настройки.",
    api_limit: "Лимит OpenAI или квота исчерпаны. Проверьте доступный лимит проекта.",
    timeout: "OpenAI не ответил за 30 секунд. Повторите запрос.",
    busy: "Сервер занят. Повторите запрос позже.",
    empty_response: "Модель не вернула завершённый текстовый ответ.",
  };
  try {
    const response = await fetch("/api/route", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: controller.signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "upstream_error");
    turn.response = body.text; turn.decision = "smoke-test";
    turn.reason = "Подключение OpenAI работает. Структурированную маршрутизацию выполняет отдельный Gateway.";
    turn.events.push("OpenAI: ответ получен");
  } catch (error) {
    if (controller.signal.aborted) return;
    turn.response = errors[error.message] || "Не удалось получить ответ API. Проверьте запуск node server.mjs и соединение.";
    turn.decision = "error"; turn.reason = "Ответ не получен; маршрут не выбран.";
    turn.events.push("Proxy: запрос не выполнен");
  } finally {
    if (requestController === controller) { requestController = null; $("#text-input-form button").disabled = false; }
  }
  if (!controller.signal.aborted) showTurn(turn);
}
function receiveGatewayEvent(event) {
  if (event.type === "transport_error") { toast(event.message); return; }
  if (event.type === "catalog_updated") {
    if (event.scenario_id === editingId) $("#save-state").textContent = "Gateway подтвердил";
    toast(`Gateway подтвердил сценарий: ${event.scenario_id}`); return;
  }
  if (!["transcript", "route_decision", "response_text", "trace", "tts_audio"].includes(event.type)) return;
  if (event.type === "transcript" && pendingTurn?.complete) pendingTurn = null;
  if (!pendingTurn) beginGatewayTurn("");
  pendingTurn.historyKey ||= pendingTurn.turn;
  if (event.type === "transcript") {
    if (typeof event.text !== "string") return;
    pendingTurn.text = event.text; pendingTurn.lang = event.lang;
    pendingTurn.events.push(`STT: ${event.is_final ? "финальный" : "промежуточный"} transcript`);
  }
  if (event.type === "route_decision") {
    if (!["route", "clarify", "handoff"].includes(event.decision)) return;
    pendingTurn.scenario = typeof event.scenario_id === "string" ? event.scenario_id : null;
    pendingTurn.label = pendingTurn.scenario || event.decision;
    pendingTurn.decision = event.decision;
    pendingTurn.confidence = Number.isFinite(event.confidence) && event.confidence >= 0 && event.confidence <= 1 ? event.confidence : null;
    pendingTurn.additional_intents = Array.isArray(event.additional_intents) ? event.additional_intents : [];
    pendingTurn.alternatives = Array.isArray(event.alternatives) ? event.alternatives : [];
    pendingTurn.additional = renderAdditional(pendingTurn.additional_intents);
    pendingTurn.reason = event.reason; pendingTurn.path = event.path || "gateway";
    pendingTurn.events.push(`Router: ${event.decision} · ${pendingTurn.scenario || "—"}`);
  }
  if (event.type === "response_text" && typeof event.text === "string") {
    pendingTurn.response = event.text; pendingTurn.events.push("Executor: ответ сформирован");
  }
  if (event.type === "trace") {
    const timings = event.timings_ms || {};
    if (event.turn_id != null) pendingTurn.turn = `#${event.turn_id}`;
    pendingTurn.timings = normalizeTimings(timings);
    pendingTurn.total = Number.isFinite(timings.total) && timings.total >= 0 ? timings.total : totalOf(pendingTurn.timings);
    pendingTurn.events.push("Trace: длительности этапов получены"); pendingTurn.complete = true;
  }
  if (event.type === "tts_audio") pendingTurn.events.push("TTS: аудиофрагмент получен; воспроизведение ещё не реализовано");
  pendingTurn.events = pendingTurn.events.slice(-30);
  showTurn(pendingTurn);
}
function normalizeTimings(timings = {}) { const labels = [["endpoint", "Endpoint"], ["stt", "STT"], ["route", "LLM router"], ["exec", "Scenario executor"], ["first_audio", "First audio"]]; return labels.filter(([key]) => Number.isFinite(timings[key]) && timings[key] >= 0).map(([key, label]) => [label, timings[key]]); }
function renderAdditional(intents) { const valid = Array.isArray(intents) ? intents.filter(intent => intent && typeof intent.scenario_id === "string") : []; return valid.length ? valid.map((intent) => `${intent.scenario_id} · ${intent.confidence ?? "—"}`).join(", ") : "Нет дополнительного намерения"; }

function loadCatalog() { try { const saved = JSON.parse(localStorage.getItem("tynda.catalog")); if (Array.isArray(saved) && saved.length && saved.length <= 100 && new Set(saved.map(item => item?.id)).size === saved.length && saved.every(item => item && /^[a-z][a-z0-9_]{2,63}$/.test(item.id) && ["title", "purpose", "boundary", "ru", "kk"].every(key => typeof item[key] === "string" && item[key].length <= 4000))) return saved; } catch { /* use seed */ } return [{ id: "payment_not_confirmed", title: "Проблема с подтверждением оплаты", purpose: "Деньги списались, но заказ или полис не подтвердился.", boundary: "Не выбирать, если клиент просит вернуть деньги: тогда refund_request.", ru: "Деньги списали, а заказ не появился", kk: "Төлем жасадым, бірақ расталмады" }, { id: "payment_failed", title: "Не прошла оплата", purpose: "Оплата не завершилась, списания нет или банк отклонил операцию.", boundary: "Если деньги уже списаны, выбрать payment_not_confirmed.", ru: "Не могу оплатить полис", kk: "Төлем неге өтпеді?" }, { id: "policy_renewal", title: "Продление полиса", purpose: "Клиент хочет продлить действующий страховой полис.", boundary: "Новый полис оформляется через new_policy.", ru: "Продлите мой полис", kk: "Полисімді ұзартқым келеді" }, { id: "refund_request", title: "Запрос на возврат", purpose: "Клиент просит вернуть деньги за проведённую операцию.", boundary: "Отмена ещё не завершённой оплаты относится к payment_cancel.", ru: "Верните деньги", kk: "Ақшамды қайтарыңыз" }]; }
function saveCatalog() { try { localStorage.setItem("tynda.catalog", JSON.stringify(catalog)); return true; } catch { toast("Хранилище недоступно: изменения останутся только до перезагрузки."); return false; } }
function renderCatalog(filter = "") { const items = catalog.filter((item) => (item.title + item.id).toLowerCase().includes(filter.toLowerCase())); $("#scenario-list").innerHTML = items.map((item) => `<button type="button" class="scenario-item ${item.id === $("#scenario-id").value ? "selected" : ""}" data-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.id)}</span></button>`).join(""); document.querySelectorAll(".scenario-item").forEach((node) => node.addEventListener("click", () => loadScenario(node.dataset.id))); }
function loadScenario(id) { const item = catalog.find((candidate) => candidate.id === id); if (!item) return; editingId = id; $("#save-state").textContent = "локальный каталог"; $("#editor-title").textContent = item.title; $("#scenario-id").value = item.id; $("#scenario-purpose").value = item.purpose; $("#scenario-boundary").value = item.boundary; $("#example-ru").value = item.ru; $("#example-kk").value = item.kk; renderCatalog($("#catalog-search").value); }
$("#catalog-search").addEventListener("input", (event) => renderCatalog(event.target.value));
$("#new-scenario").addEventListener("click", () => { const id = `scenario_${Date.now()}`; catalog.unshift({ id, title: "Новый сценарий", purpose: "Опишите, какую задачу клиента решает сценарий.", boundary: "Опишите границу с близкими сценариями.", ru: "", kk: "" }); saveCatalog(); loadScenario(id); toast("Черновик сценария добавлен"); });
$("#scenario-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = $("#scenario-id").value.trim();
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(id)) { toast("ID: латиница, цифры и _; минимум 3 символа"); return; }
  if (catalog.some(item => item.id === id && item.id !== editingId)) { toast("Этот ID уже существует. Выберите другой."); return; }
  if (gatewayUrl && id !== editingId) { toast("При подключённом Gateway ID неизменяем: создайте отдельный сценарий."); return; }
  const purpose = $("#scenario-purpose").value.trim(), boundary = $("#scenario-boundary").value.trim();
  if (!purpose || !boundary) { toast("Заполните назначение и границу сценария."); return; }
  const item = { id, title: purpose.split(".")[0].slice(0, 52), purpose, boundary, ru: $("#example-ru").value.trim(), kk: $("#example-kk").value.trim() };
  const index = catalog.findIndex(candidate => candidate.id === editingId);
  if (index >= 0) catalog[index] = item; else catalog.unshift(item);
  const persisted = saveCatalog(); editingId = id;
  $("#editor-title").textContent = item.title;
  $("#save-state").textContent = persisted ? "сохранено локально" : "только в памяти";
  renderCatalog($("#catalog-search").value);
  if (gatewayUrl && gateway.send({ type: "catalog_upsert", scenario: item })) $("#save-state").textContent = "ожидаем Gateway";
  toast("Каталог обновлён. Публикация подтверждается отдельным событием Gateway.");
});
$("#delete-scenario").addEventListener("click", () => {
  if (catalog.length <= 1) { toast("Нужен хотя бы один сценарий"); return; }
  catalog = catalog.filter(item => item.id !== editingId);
  saveCatalog(); loadScenario(catalog[0].id);
  toast("Удалено только из локального каталога; серверный каталог не изменён.");
});
$("#all-routes").addEventListener("click", () => { showAllRoutes = !showAllRoutes; $("#all-routes").textContent = showAllRoutes ? "Последние 4" : "Все"; renderHistory(); });
$("#handoff-queue").addEventListener("click", () => toast("Демо-карточка. Очередь операторов подключается на стороне backend."));
$("#export-csv").addEventListener("click", () => {
  const cell = value => '"' + String(value ?? "").replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
  const rows = [["turn", "time", "scenario_id", "decision", "total_ms", "source"], ...[...history.values()].map(t => [t.turn, t.time, t.scenario || "", t.decision, t.total || totalOf(t.timings), t.source || t.path])];
  const url = URL.createObjectURL(new Blob(["\uFEFF" + rows.map(row => row.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = "tynda-session-routes.csv"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

Object.values(demos).slice(0, 3).reverse().forEach(appendRoute); loadScenario(catalog[0].id);
