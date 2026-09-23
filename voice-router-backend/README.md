# Tyńda · Backend Gateway

Совместимый backend для соседней папки `voice-router-frontend`. Node.js + WebSocket (`ws`), без Python, Docker или внешней базы.

## Быстрый запуск

Требуется Node.js 20.19+ (проверено на 24.19). Зависимость уже установлена на текущем компьютере.

Из корня репозитория:

```powershell
cd voice-router-backend
node src/server.mjs
```

Откройте **http://127.0.0.1:8000**. Backend отдаёт соседний frontend и автоматически подставляет URL Gateway. Отдельный frontend-сервер не нужен. Остановка — Ctrl+C в обычном терминале.

На чистом компьютере сначала установите зависимость одним из способов:

```powershell
pnpm install --frozen-lockfile
# либо, если установлен Node.js с npm:
npm install --ignore-scripts
```

Альтернативно можно оставить frontend на 8787 и открыть:
`http://127.0.0.1:8787/?gateway=ws://127.0.0.1:8000/ws`.

## Режимы

По умолчанию **ROUTER_MODE=demo**, даже если в окружении есть ключ. Платных вызовов нет. Демо сравнивает текст с точными примерами каталога и четырьмя фразами интерфейса. Незнакомая фраза вызывает уточнение. Это не LLM, не обученный классификатор и не проверка качества.

Для настоящего роутера:

1. Скопируйте `.env.example` в `.env` в **этой** папке.
2. Установите `ROUTER_MODE=openai` и новый `OPENAI_API_KEY`.
3. Модель задаётся `OPENAI_MODEL`, по умолчанию `gpt-5-mini`.
4. Для распознавания и озвучивания дополнительно включите `VOICE_ENABLED=true`.
5. Перезапустите сервер. Ключ из старой переписки не используйте и не присылайте в чат.

`STT_MODEL=gpt-transcribe`, `TTS_MODEL=gpt-4o-mini-tts`, `TTS_VOICE=coral` можно изменить на доступные проекту значения. Наличие ключа не доказывает доступ к моделям или наличие квоты.

Адаптер LLM использует [Responses Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs): строгая JSON Schema плюс локальная проверка ID по снимку каталога. [STT](https://developers.openai.com/api/docs/guides/speech-to-text) получает WAV завершённой реплики; [TTS](https://developers.openai.com/api/docs/guides/text-to-speech) возвращает MP3. В интерфейсе указано, что голос синтезирован ИИ.

## Что реализовано

- WebSocket Gateway `/ws`: текст и PCM16 mono 16 kHz.
- Состояние каждого подключения: история 6 последних обменов, активный сценарий, дополнительные темы, число уточнений.
- Ответы `route / clarify / handoff`; после двух вопросов следующая неразрешённая неоднозначность создаёт карточку в локальной очереди.
- Серверный каталог: добавление, обновление, удаление, версия, 8 начальных сценариев.
- История решений, измеренные серверные задержки, агрегаты супервизора и очередь handoff.
- Frontend загружает каталог и историю с сервера; кнопки примеров проходят через Gateway.
- Проигрывание MP3 с управляющими кнопками. Если autoplay запрещён, пользователь нажимает ▶.
- Серверные ключи, ограниченные размеры сообщений/аудио, проверка Origin/Host, лимиты запросов.

Никаких настоящих платежей, возвратов, изменений полиса или соединения с оператором нет. Executor обновляет только состояние диалога. Локальная карточка handoff — не реальный перевод звонка.

## HTTP API

Все данные JSON. Для запросов с телом нужен `Content-Type: application/json`.

| Метод и URL | Назначение |
|---|---|
| GET /api/health | Режим, настройка речи, наличие ключа без его значения |
| GET /api/catalog | `{version, scenarios}` |
| POST /api/catalog | Создать/обновить `{id,title,purpose,boundary,ru,kk}` |
| PUT /api/catalog/:id | Обновить, ID тела должен совпадать с URL |
| DELETE /api/catalog/:id | Удалить; последний сценарий удалить нельзя |
| POST /api/route | `{"text":"..."}` → текст, решение, trace; отдельный stateless-запрос |
| GET /api/traces?limit=50&mode=demo | Последние записи, limit 1–500 |
| GET /api/supervisor | Агрегаты текущего режима |
| GET /api/handoffs | Локальные карточки, включая закрытые |
| PATCH /api/handoffs/:id | `{"status":"closed"}` |

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/route -Method Post -ContentType 'application/json' -Body '{"text":"Не могу оплатить полис"}'
```

Для контекста диалога используйте WebSocket; отдельные HTTP-запросы не разделяют историю.

## WebSocket

Клиент отправляет:
- `text_input`: text (1–600 символов), client_ts.
- `audio_chunk`: pcm16 (base64 little-endian), sample_rate_hz=16000.
- `speech_end`: завершение реплики.
- `catalog_get`, `catalog_upsert` (scenario), `catalog_delete` (scenario_id).
- `supervisor_get`, `handoff_list`.

При соединении: `session_open`, `catalog_snapshot`, `supervisor_stats`, `trace_history`.

На реплику: `turn_started → transcript → route_decision → response_text → [tts_audio] → trace → supervisor_stats`. У событий один turn_id. Ошибка даёт `transport_error`; начатая неуспешная реплика завершается trace с error.

`tts_audio`: chunk — полный MP3 в base64, mime_type=audio/mpeg, is_final=true, ai_generated=true. Это один ограниченный аудиофайл, а не настоящий поток воспроизводимых фрагментов.

Публикация каталога подтверждается только после записи на диск: `catalog_updated`/ `catalog_deleted`. Другие уже открытые клиенты запрашивают свежий каталог через catalog_get или перезагрузку; роутер всегда использует последний серверный снимок.

## Измерения и ограничения

- Metrics разделены по режимам demo/openai. Accuracy = null без размеченного eval.
- `route`, `exec`, `stt` и генерация TTS измеряются серверными часами. `first_audio` здесь — время получения полного MP3, **не** первый звук в браузере.
- Client VAD, запись до speech_end, запись JSON на диск, сеть и playback не входят в total.
- Confidence модели не калиброван. Порог 0.65 — стартовая dev-политика для уточнения, а не доказательство качества.
- Голосовой режим half-duplex: во время обработки/озвучивания микрофонные фрагменты не маршрутизируются. Barge-in, Realtime STT и потоковый TTS не реализованы.
- Максимум реплики 30 секунд, тишина не накапливается. В память хранится PCM, на диск аудио не записывается.
- До 16 соединений, 4 одновременных turn pipeline, 20 реплик/мин на сессию и 60/мин на процесс.
- Входящий WS-кадр до 64 KiB, HTTP JSON до 32 KiB; есть backpressure и heartbeat.
- Нет авторизации пользователей. Сервер слушает **только 127.0.0.1**. Не выставляйте его наружу через туннель/прокси без отдельной защиты.

## Хранилище и приватность

`data/state.json`: каталог, последние 500 traces и 200 handoff-карточек. Текст и история сохраняются локально без шифрования — используйте только синтетические данные. `data/`, `.env`, `node_modules/` исключены из Git и недоступны по HTTP.

Записи сериализованы и заменяют JSON атомарно через временный файл. Поддерживается **один процесс** на каталог данных; `data/.lock` содержит PID. При обычной остановке он удаляется. После аварийного завершения сначала убедитесь, что процесс с указанным PID больше не работает, и только затем удалите этот lock-файл. Повреждённый state.json не перезаписывается автоматически.

`store:false` в Responses не означает отсутствие всей обработки/логирования у провайдера. Не отправляйте реальные клиентские сведения.

## Проверки

```powershell
node --test
```

17 backend-тестов: HTTP/WS, сохранение и блокировка хранилища, валидация, demo routing, escalation, ошибки, лимиты аудио, адаптеры OpenAI. Внешний API подменён; ключ и расходы не нужны. Соседний frontend имеет ещё 12 тестов.

Также проверен настоящий HTTP/WebSocket-путь в браузере: каталог, маршрут, clarify/handoff, статистика, CSV, восстановление истории после перезапуска, desktop/mobile. Реальный вызов OpenAI и качество ru/kk speech требуют отдельного прогона новым ключом.

## Структура

```text
src/config.mjs       окружение и безопасные локальные defaults
src/server.mjs       HTTP, static allowlist, upgrade /ws
src/gateway.mjs      сессии, pipeline и события
src/provider.mjs     demo / OpenAI routing, STT, TTS
src/store.mjs        JSON-хранилище, версии, метрики
src/validation.mjs   проверка каталога и решений
src/audio.mjs        PCM16, ограниченный буфер, WAV
src/errors.mjs       безопасные ошибки
catalog.seed.json    начальные 8 сценариев
test/                автономные проверки
```
