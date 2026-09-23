import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { AudioBuffer, decodePcm } from "./audio.mjs";
import { AppError, publicError } from "./errors.mjs";
import { textInput, validateDecision } from "./validation.mjs";

export function createSession() {
  return { id: randomUUID(), history: [], activeScenario: null, pendingIntents: [], clarifyCount: 0, busy: false, turns: 0, windowStart: Date.now(), requests: 0 };
}
const elapsed = start => Math.round((performance.now() - start) * 10) / 10;

export class Engine {
  active = 0; requests = 0; windowStart = Date.now();
  constructor({ store, provider, config }) { Object.assign(this, { store, provider, config }); }
  async run(session, input, emit = () => {}, signal) {
    if (session.busy || this.active >= 4) throw new AppError("busy", "Обрабатывается предыдущая реплика. Дождитесь ответа.", 429);
    const now = Date.now();
    for (const counter of [session, this]) if (now - counter.windowStart >= 60000) { counter.windowStart = now; counter.requests = 0; }
    if (session.requests >= 20 || this.requests >= 60) throw new AppError("rate_limit", "Лимит реплик в минуту достигнут.", 429);
    session.requests++; this.requests++; session.busy = true; this.active++;
    const turn_id = `${session.id.slice(0,8)}-${++session.turns}`;
    const started = performance.now(), timings = {};
    const previousState = structuredClone({ history: session.history, activeScenario: session.activeScenario, pendingIntents: session.pendingIntents, clarifyCount: session.clarifyCount });
    let text = input.text, record, result;
    emit({ type: "turn_started", turn_id, mode: this.config.mode });
    try {
      if (input.pcm) {
        if (!this.config.voiceEnabled) throw new AppError("voice_disabled", "Для речи задайте ROUTER_MODE=openai и VOICE_ENABLED=true.");
        const start = performance.now(); text = await this.provider.transcribe(input.pcm, signal); timings.stt = elapsed(start);
      }
      text = textInput(text);
      emit({ type: "transcript", turn_id, text, lang: "unknown", is_final: true });
      const snapshot = this.store.catalog();
      let start = performance.now();
      result = validateDecision(await this.provider.route({ text, catalog: snapshot.scenarios, session, signal }), snapshot.scenarios);
      timings.route = elapsed(start);
      start = performance.now();
      if (result.decision === "route" && result.confidence < .65) {
        result.alternatives = [{ scenario_id: result.scenario_id, confidence: result.confidence, why_not: "Ниже демонстрационного порога 0.65" }];
        result.scenario_id = null; result.decision = "clarify";
        result.response_text = result.language === "kk" ? "Сұрағыңызды нақтылай аласыз ба?" : "Уточните, пожалуйста, какую задачу нужно решить?";
      }
      if (result.decision === "clarify") {
        if (session.clarifyCount >= 2) {
          result.decision = "handoff"; result.scenario_id = null;
          result.reason = "Два уточнения не помогли выбрать сценарий.";
          result.response_text = result.language === "kk" ? "Сұрау жергілікті оператор кезегіне тіркеледі. Оператор әлі қосылған жоқ." : "Создам карточку в локальной очереди. Оператор пока не подключён.";
        } else session.clarifyCount++;
      } else session.clarifyCount = 0;
      if (result.decision === "route") session.activeScenario = result.scenario_id;
      const ids = new Set(snapshot.scenarios.map(s => s.id));
      session.pendingIntents = [...new Map([...session.pendingIntents, ...result.additional_intents].filter(x => ids.has(x.scenario_id) && x.scenario_id !== result.scenario_id).map(x => [x.scenario_id, x])).values()].slice(0, 4);
      session.history.push({ role: "user", content: text }, { role: "assistant", content: result.response_text });
      session.history = session.history.slice(-12);
      timings.exec = elapsed(start);
      let audio = null, speechError = null;
      if (this.config.voiceEnabled) {
        start = performance.now();
        try { audio = await this.provider.synthesize(result.response_text, signal); timings.first_audio = elapsed(start); }
        catch (error) { if (signal?.aborted) throw error; speechError = publicError(error); }
      }
      if (signal?.aborted) throw new AppError("cancelled", "Запрос отменён.", 499);
      timings.total = elapsed(started);
      record = { turn_id, session_id: session.id, created_at: new Date().toISOString(), mode: this.config.mode, text, decision: result, timings_ms: timings, catalog_version: snapshot.version, history: session.history.slice(), speech_error: speechError, measurement: "Server processing; excludes client VAD, persistence, transport and playback" };
      await this.store.addTrace(record);
      emit({ type: "route_decision", turn_id, ...result, path: this.config.mode === "demo" ? "demo" : "llm", source: this.config.mode, catalog_version: snapshot.version });
      emit({ type: "response_text", turn_id, text: result.response_text });
      if (audio) emit({ type: "tts_audio", turn_id, chunk: audio.toString("base64"), mime_type: "audio/mpeg", is_final: true, ai_generated: true });
      if (speechError) emit({ type: "transport_error", scope: "tts", ...speechError, message: "Текст получен, но озвучивание недоступно. " + speechError.message });
      emit({ type: "trace", ...record });
      emit({ type: "supervisor_stats", ...this.store.metrics(this.config.mode) });
      return { text: result.response_text, decision: result, trace: record, mode: this.config.mode };
    } catch (error) {
      Object.assign(session, previousState);
      const failure = publicError(error);
      const failed = { turn_id, session_id: session.id, created_at: new Date().toISOString(), mode: this.config.mode, text: typeof text === "string" ? text.slice(0,600) : "", decision: null, error: failure.error, timings_ms: { ...timings, total: elapsed(started) }, history: [] };
      if (!signal?.aborted) {
        await this.store.addTrace(failed).catch(() => {});
        emit({ type: "transport_error", scope: "turn", turn_id, ...failure });
        emit({ type: "trace", ...failed });
      }
      throw error;
    } finally { session.busy = false; this.active--; }
  }
}

export function attachGateway(ws, engine) {
  const session = createSession(), audio = new AudioBuffer(), controller = new AbortController();
  const send = payload => {
    if (ws.readyState !== 1) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) { ws.close(1013, "Client too slow"); controller.abort(); return; }
    ws.send(JSON.stringify(payload));
  };
  const snapshot = () => send({ type: "catalog_snapshot", ...engine.store.catalog() });
  send({ type: "session_open", session_id: session.id, mode: engine.config.mode, voice_enabled: engine.config.voiceEnabled, capabilities: ["catalog_snapshot", "catalog_delete", "supervisor_stats", "handoff_list", "tts_audio"], ai_voice_notice: "Голос синтезирован ИИ, это не человек." });
  snapshot();
  send({ type: "supervisor_stats", ...engine.store.metrics(engine.config.mode) });
  send({ type: "trace_history", items: engine.store.traces(50, engine.config.mode) });
  let messages = 0, windowStart = Date.now(), catalogBusy = false;
  ws.on("message", async (raw, isBinary) => {
    let payload;
    try {
      if (Date.now() - windowStart > 60000) { messages = 0; windowStart = Date.now(); }
      if (++messages > 1200) { ws.close(1008, "Message rate exceeded"); return; }
      if (isBinary) throw new AppError("invalid_message", "Ожидается JSON, не бинарный кадр.");
      try { payload = JSON.parse(raw.toString()); } catch { throw new AppError("invalid_json", "Некорректный JSON."); }
      if (!payload || Array.isArray(payload) || typeof payload.type !== "string") throw new AppError("invalid_message", "Ожидается объект с type.");
      if (payload.type === "audio_chunk") {
        if (!engine.config.voiceEnabled) throw new AppError("voice_disabled", "Голосовой канал выключен; используйте текст.");
        if (!session.busy) audio.push(decodePcm(payload.pcm16, payload.sample_rate_hz));
        return;
      }
      if (payload.type === "speech_end") {
        const pcm = audio.take();
        if (pcm && !session.busy) {
          try { await engine.run(session, { pcm }, send, controller.signal); }
          catch (error) { if (["busy", "rate_limit"].includes(error.code)) throw error; }
        }
        return;
      }
      if (payload.type === "text_input") {
        const text = textInput(payload.text);
        if (session.busy) throw new AppError("busy", "Дождитесь завершения предыдущей реплики.", 429);
        audio.clear();
        // Engine emits terminal errors; preflight errors are handled below.
        try { await engine.run(session, { text }, send, controller.signal); }
        catch (error) { if (["busy", "rate_limit"].includes(error.code)) throw error; }
        return;
      }
      if (payload.type === "catalog_get") { snapshot(); return; }
      if (payload.type === "supervisor_get") { send({ type: "supervisor_stats", ...engine.store.metrics(engine.config.mode) }); return; }
      if (payload.type === "handoff_list") { send({ type: "handoff_snapshot", items: engine.store.handoffs() }); return; }
      if (["catalog_upsert", "catalog_delete"].includes(payload.type)) {
        if (catalogBusy) throw new AppError("busy", "Дождитесь сохранения каталога.", 429);
        catalogBusy = true;
        try {
          if (payload.type === "catalog_upsert") {
            const update = await engine.store.upsert(payload.scenario);
            send({ type: "catalog_updated", scenario_id: update.scenario.id, ...update });
          } else {
            const result = await engine.store.deleteScenario(payload.scenario_id);
            send({ type: "catalog_deleted", ...result }); snapshot();
          }
        } finally { catalogBusy = false; }
        return;
      }
      throw new AppError("unknown_event", "Неизвестный тип события.");
    } catch (error) { send({ type: "transport_error", scope: payload?.type || "protocol", ...publicError(error) }); }
  });
  ws.on("close", () => { controller.abort(); audio.clear(); });
  ws.on("error", () => { controller.abort(); audio.clear(); });
  return session;
}
