# Voice Router (Tyńda) — HackAlem AI × Halyk, Кейс 2

## Что строим
Голосовой робот страховой компании. Клиент говорит на русском, казахском или вперемешку,
LLM выбирает один из ~40 сценариев с учётом всего диалога. Супервизор видит каждое решение:
сценарий, обоснование, альтернативы, уверенность, задержку по этапам.

Конвейер одной реплики: VAD (браузер) → STT → Dialog Manager → LLM-роутер → Исполнитель
сценария (mock_backend) → TTS → воспроизведение. На каждом этапе ставим timestamp.

## Как оценивает жюри
- Работоспособность (25): 5 must-have вживую + 10 скрытых реплик (простые, смена темы,
  смешанная речь, стык сценариев; 2 на казахском, 1 смешанная)
- Техническая реализация (25): LLM в точке решения, архитектура, трассировка
- README и воспроизводимость (25): запуск одной командой `docker compose up`
- Ценность (15), оригинальность (10)
- Порядок приоритетов: точность → стабильность → README → скорость → wow-фичи

## Жёсткие правила (нарушение = дисквалификация)
1. Сценарий выбирает только LLM. Никаких intent-классификаторов (BERT, эмбеддинги
   + классификатор, fine-tune) и keyword matching для выбора сценария.
2. Никакого хардкода фраз (`if "оплатил" in text`). Путаницы лечим описанием смысла.
3. Фразы из eval-наборов (dev_utterances, tune, holdout, synthetic, voice) никогда
   не попадают в промпт как примеры. Holdout не трогаем до финала.
4. Выход роутера — только JSON по схеме. Свободный текст LLM не исполняется.
5. Необратимые действия (отмена полиса, возврат) — только после явного «да» клиента.
6. Fast path (без LLM) — только для ответа на вопрос робота внутри уже выбранного
   LLM сценария («да», дата, номер полиса).
7. Ключи только в `.env`. В git — только `.env.example`.
8. Реальные записи клиентских разговоров запрещены, только синтетика и свои голоса.

## Команда и зоны
Чужую зону не трогать без согласования с её владельцем.
- **Алихан — AI Lead:** `backend/app/router/`, `eval/`, `data/mock/`. Роутер, промпт,
  JSON-схема, уверенность, мульти-интенты, стек тем, переспрос, handoff, eval,
  bake-off LLM, синтетический набор. Мержит ветки в main.
- **Тылеу — Backend & Voice:** `backend/app/main.py`, `backend/app/speech/`,
  `backend/app/dialog/`, `backend/app/trace/`, `backend/app/api/`, `docker-compose.yml`.
  FastAPI, WebSocket, STT/TTS-адаптеры, Dialog Manager, Исполнитель, замеры задержки.
- **Сарик — Frontend, README, питч:** `frontend/`, `README.md`, `docs/` (кроме
  `docs/contracts/router.md` и `docs/evaluation.md`). Экран звонка, трассировка-водопад,
  дашборд супервизора, редактор каталога.

## Стек
- Backend: Python 3.11+, FastAPI, uvicorn, asyncio, Pydantic v2, SQLite, pytest
- Frontend: React + Vite + Tailwind, @ricky0123/vad-web
- Внешние сервисы (LLM, STT, TTS) — только через адаптеры (adapter pattern):
  базовый класс + провайдер, выбор в `.env`. Смена провайдера = одна строка в `.env`
- Запуск: Docker Compose, `Makefile`

## Структура
```
data/                  # стартовый кит — НЕ редактировать
data/mock/             # наши моковые данные
backend/app/
  main.py              # FastAPI + WebSocket
  speech/              # stt_base.py, tts_base.py, адаптеры
  router/              # catalog, schema, prompt, llm_router, confidence, policy, providers/
  dialog/              # state, manager, executor
  trace/               # timings, store (SQLite)
  api/                 # REST: трассировки, статистика, каталог
frontend/src/pages/    # Call, Trace, Supervisor, CatalogEditor
eval/                  # datasets/, run_eval.py, reports/
docs/                  # architecture, evaluation, latency, contracts/, decisions/ (ADR)
```

## Контракты
Подробно — в `docs/contracts/`. Меняются только по согласованию всех троих.
- WS клиент → сервер: `audio_chunk {pcm16, 16kHz}`, `speech_end {client_ts}`, `text_input {text}`
- WS сервер → клиент: `transcript {text, lang, is_final}`,
  `route_decision {scenario_id, decision, confidence, alternatives, reason, path: "llm"|"fast"}`,
  `response_text {text}`, `tts_audio {chunk}`,
  `trace {turn_id, timings_ms: {endpoint, stt, route, exec, first_audio, total}}`
- Роутер: `async route(state, utterance) -> RouteResult`, `policy.apply(state, result) -> DialogState`
- Все замеры времени — на сервере через `time.perf_counter()`

## Команды
- `make run` — запуск без Docker, `docker compose up` — запуск всего
- `make test` — pytest
- `make eval` — полный eval на tune, `make eval-quick` — 30 фраз перед мержем
- `make leakage` — проверка, что фразы из eval не попали в промпт

## Git
- `main` всегда рабочий. Каждый работает в своей ветке: `ai/*`, `backend/*`, `front/*`
- Перед мержем: `make test`, для изменений роутера ещё `make leakage && make eval-quick`
- Мержит Алихан. Сломалось в main — сразу `git revert`
- Коммиты: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`

## Как работать (для AI-агента)
- Отвечай на русском, коротко. Английские термины можно, с переводом в скобках
- Перед работой коротко напиши план, потом делай
- Не выдумывай: формат файлов кита, ключи, названия моделей — спроси
- Возможности внешних API (structured output, logprobs, streaming, казахский язык)
  проверяй по документации провайдера, не угадывай
- Простой код: type hints, короткие функции, без лишних абстракций
- Тесты не ходят в реальные API — используй фейковые провайдеры
- Каждое улучшение роутера подтверждай прогоном eval (нет цифры — нет улучшения)
- В конце задачи — короткий отчёт: что изменено, как проверить, что требует решения