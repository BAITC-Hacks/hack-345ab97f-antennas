import { mkdir, readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { scenarioInput, validId } from "./validation.mjs";
import { AppError } from "./errors.mjs";

export class Store {
  constructor(directory) { this.directory = directory; this.tail = Promise.resolve(); }
  async init() {
    await mkdir(this.directory, { recursive: true });
    this.lockPath = join(this.directory, ".lock");
    try { this.lock = await open(this.lockPath, "wx"); await this.lock.writeFile(String(process.pid)); }
    catch (error) { if (error.code === "EEXIST") throw new Error("Data directory is locked. Stop the other backend. After a crash, verify its PID is gone before removing data/.lock."); throw error; }
    this.path = join(this.directory, "state.json");
    try {
      try { this.state = JSON.parse(await readFile(this.path, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        const catalog = JSON.parse(await readFile(new URL("../catalog.seed.json", import.meta.url), "utf8")).map(scenarioInput);
        this.state = { schema_version: 1, catalog_version: 1, catalog, traces: [], handoffs: [] };
        await this.persist(this.state);
      }
      const s = this.state;
      if (s.schema_version !== 1 || !Array.isArray(s.catalog) || !s.catalog.length || s.catalog.length > 100 || !Array.isArray(s.traces) || !Array.isArray(s.handoffs) || !Number.isInteger(s.catalog_version)) throw new Error("Invalid data/state.json. Original file was not overwritten.");
      s.catalog.forEach(scenarioInput);
      if (new Set(s.catalog.map(x => x.id)).size !== s.catalog.length) throw new Error("Duplicate catalog IDs in state.json");
    } catch (error) { await this.close(); throw error; }
    return this;
  }
  async persist(state) {
    const temporary = this.path + ".tmp";
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }
  transaction(update) {
    const task = this.tail.then(async () => {
      const draft = structuredClone(this.state);
      const result = update(draft);
      await this.persist(draft);
      this.state = draft;
      return structuredClone(result);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  catalog() { return { version: this.state.catalog_version, scenarios: structuredClone(this.state.catalog) }; }
  upsert(input) {
    const scenario = scenarioInput(input);
    return this.transaction(state => {
      const index = state.catalog.findIndex(s => s.id === scenario.id);
      if (index < 0) {
        if (state.catalog.length >= 100) throw new AppError("catalog_full", "Максимум 100 сценариев.", 409);
        state.catalog.push(scenario);
      } else state.catalog[index] = scenario;
      state.catalog_version++;
      return { scenario, version: state.catalog_version };
    });
  }
  deleteScenario(id) {
    if (!validId(id)) throw new AppError("invalid_id", "Некорректный ID.");
    return this.transaction(state => {
      if (!state.catalog.some(s => s.id === id)) throw new AppError("not_found", "Сценарий не найден.", 404);
      if (state.catalog.length <= 1) throw new AppError("last_scenario", "Нужен хотя бы один сценарий.", 409);
      state.catalog = state.catalog.filter(s => s.id !== id);
      state.catalog_version++;
      return { scenario_id: id, version: state.catalog_version };
    });
  }
  addTrace(trace) {
    return this.transaction(state => {
      state.traces.unshift(trace); state.traces = state.traces.slice(0, 500);
      if (trace.decision?.decision === "handoff") {
        state.handoffs.unshift({ id: randomUUID(), created_at: trace.created_at, session_id: trace.session_id, turn_id: trace.turn_id, status: "open", mode: trace.mode, language: trace.decision.language, text: trace.text, reason: trace.decision.reason, alternatives: trace.decision.alternatives, history: trace.history });
        state.handoffs = state.handoffs.slice(0, 200);
      }
      return trace;
    });
  }
  traces(limit = 50, mode) { return structuredClone(this.state.traces.filter(t => !mode || t.mode === mode).slice(0, limit)); }
  handoffs() { return structuredClone(this.state.handoffs); }
  resolveHandoff(id) {
    return this.transaction(state => {
      const entry = state.handoffs.find(h => h.id === id);
      if (!entry) throw new AppError("not_found", "Карточка не найдена.", 404);
      entry.status = "closed"; return entry;
    });
  }
  metrics(mode) {
    const rows = this.state.traces.filter(t => t.mode === mode);
    const decisions = rows.filter(t => t.decision);
    const latencies = decisions.map(t => t.timings_ms.route).filter(Number.isFinite).sort((a,b) => a-b);
    const percentile = p => latencies.length ? latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] : null;
    const ratio = decision => decisions.length ? Math.round(1000 * decisions.filter(t => t.decision.decision === decision).length / decisions.length) / 10 : 0;
    return { mode, sample_size: decisions.length, error_count: rows.length - decisions.length, accuracy: null, accuracy_note: "Нет размеченного eval-набора", routing_p50_ms: percentile(.5), routing_p95_ms: percentile(.95), clarify_rate: ratio("clarify"), handoff_rate: ratio("handoff"), languages: Object.fromEntries(["ru","kk","mixed","unknown"].map(lang => [lang, decisions.filter(t => t.decision.language === lang).length])), retention: "Последние 500 поворотов, не 24 часа" };
  }
  async close() { await this.tail; if (this.lock) { await this.lock.close(); this.lock = null; await unlink(this.lockPath); } }
}
