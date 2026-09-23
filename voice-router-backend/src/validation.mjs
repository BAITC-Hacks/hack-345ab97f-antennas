import { AppError } from "./errors.mjs";

export const validId = value => typeof value === "string" && /^[a-z][a-z0-9_]{2,63}$/.test(value);
export function textInput(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 600) throw new AppError("invalid_text", "Текст должен содержать 1–600 символов.");
  return value.trim();
}
export function scenarioInput(input) {
  if (!input || typeof input !== "object" || !validId(input.id)) throw new AppError("invalid_scenario", "Некорректный ID сценария.");
  const output = { id: input.id };
  for (const field of ["title", "purpose", "boundary", "ru", "kk"]) {
    if (typeof input[field] !== "string" || input[field].length > 4000 || (["title", "purpose", "boundary"].includes(field) && !input[field].trim())) {
      throw new AppError("invalid_scenario", "Заполните название, назначение и границу; максимум 4000 символов на поле.");
    }
    output[field] = input[field].trim();
  }
  return output;
}
export function validateDecision(value, catalog) {
  const fail = () => { throw new AppError("invalid_model_output", "Ответ модели не прошёл проверку; маршрут не выполнен.", 502); };
  if (!value || !["route", "clarify", "handoff"].includes(value.decision)) fail();
  const ids = new Set(catalog.map(s => s.id));
  if (value.scenario_id !== null && !ids.has(value.scenario_id)) fail();
  if (value.decision === "route" && !value.scenario_id) fail();
  if (value.decision !== "route" && value.scenario_id !== null) fail();
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) fail();
  if (!["ru", "kk", "mixed", "unknown"].includes(value.language)) fail();
  for (const field of ["reason", "response_text"]) if (typeof value[field] !== "string" || !value[field].trim() || value[field].length > 1200) fail();
  for (const field of ["additional_intents", "alternatives"]) {
    if (!Array.isArray(value[field]) || value[field].length > 4) fail();
    const seen = new Set();
    for (const item of value[field]) {
      if (!item || !ids.has(item.scenario_id) || seen.has(item.scenario_id) || item.scenario_id === value.scenario_id || typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) fail();
      if (field === "alternatives" && (typeof item.why_not !== "string" || item.why_not.length > 600)) fail();
      seen.add(item.scenario_id);
    }
  }
  return {
    scenario_id: value.scenario_id, decision: value.decision, confidence: value.confidence,
    language: value.language, reason: value.reason, response_text: value.response_text,
    additional_intents: value.additional_intents.map(({ scenario_id, confidence }) => ({ scenario_id, confidence })),
    alternatives: value.alternatives.map(({ scenario_id, confidence, why_not }) => ({ scenario_id, confidence, why_not })),
  };
}
export function decisionSchema(catalog) {
  const id = { type: "string", enum: catalog.map(s => s.id) };
  const confidence = { type: "number", minimum: 0, maximum: 1 };
  const object = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
  return object({
    scenario_id: { anyOf: [id, { type: "null" }] }, decision: { type: "string", enum: ["route", "clarify", "handoff"] },
    confidence, language: { type: "string", enum: ["ru", "kk", "mixed", "unknown"] },
    reason: { type: "string" }, response_text: { type: "string" },
    additional_intents: { type: "array", maxItems: 4, items: object({ scenario_id: id, confidence }) },
    alternatives: { type: "array", maxItems: 4, items: object({ scenario_id: id, confidence, why_not: { type: "string" } }) },
  });
}
