# Контракт LLM-роутера

## Dialog Manager (Тылеу)

Dialog Manager создаёт `DialogState` и `Utterance`, затем вызывает только async API:

```python
result = await router.route(state, utterance, on_commit=early_callback)
state = policy.apply(state, result)
```

`on_commit` вызывается один раз, когда поток закрыл первые два поля JSON — `scenario_id` и
`decision`. Callback пригоден для подготовки сценария, но необратимые действия должны ждать
полностью провалидированный `RouteResult`. При старте приложения вызывается
`await router.warm_up()`.

Каталог читается перед каждым вызовом `route`, поэтому редактор может атомарно заменить
`data/scenarios.json` без перезапуска backend. После завершения сценария Dialog Manager передаёт
копию результата с `final_action="complete"` в `policy.apply`: сначала будет выбран первый
`pending_intents`, затем последняя отложенная тема из `topic_stack`.

## Трассировка (Сарик)

`RouteResult.model_dump(mode="json")` передаётся как payload события `route_decision` без
преобразования свободного текста:

```json
{
  "decision": {
    "scenario_id": "payment_issue",
    "decision": "route",
    "alternatives": [
      {"scenario_id": "policy_status", "why_not": "Упомянуто списание оплаты"}
    ],
    "additional_intents": [
      {"scenario_id": "change_delivery_address"}
    ],
    "slots": [],
    "language": "ru",
    "topic_switch": false,
    "emotion": "anxious",
    "reason": "Оплата списана, подтверждения нет"
  },
  "confidence": 0.82,
  "margin": 0.37,
  "final_action": "route",
  "clarify_question": null,
  "handoff_card": null,
  "path": "llm",
  "model": "configured-model",
  "prompt_version": "router-v1.0",
  "timings_ms": {"commit": 180.4, "full": 423.7}
}
```

`confidence` и `margin` вычисляет приложение, модель их не возвращает. `confidence` — вероятность
значения `scenario_id` по logprobs его токенов, `margin` — наименьший отрыв выбранного токена от
лучшей альтернативы внутри этого значения. Если провайдер не отдаёт logprobs (`LLM_LOGPROBS=false`),
оба числа — грубая оценка по числу альтернатив и не меняют решение LLM. `decision.language`
(`ru`/`kk`/`mixed`) определяет отдельный короткий LLM-запрос, который идёт параллельно
маршрутизации: внутри маршрутизации модель путала казахские просьбы об операторе с русскими. Если
этот запрос не удался, остаётся язык из ответа роутера. `commit` — время до
закрытия первых двух полей потокового JSON, `full` — время до полной валидации и policy gates.
