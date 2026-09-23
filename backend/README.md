# Tyńda backend

Python 3.11+, FastAPI, WebSocket, SQLite. Сценарий выбирает только существующий LLM-роутер.
Сервер исполняет **учебные** ответы из каталога, не обращается к реальной страховой системе и
не выполняет возвраты или отмену полиса.

## Запуск

1. Скопируйте `.env.example` в `.env` и заполните `LLM_API_KEY` и `LLM_MODEL`.
2. `docker compose up --build` поднимет backend и frontend (или `pip install -r requirements.txt` и `make run` для одного backend).
3. Интерфейс: `http://localhost:5173/call`; backend: `http://localhost:8000/health`, документация API: `http://localhost:8000/docs`.

Для аудио установите `STT_PROVIDER=openai` и `TTS_PROVIDER=openai`, а также `SPEECH_API_KEY`
(если пустой, используется `LLM_API_KEY`). По умолчанию голос отключён; текстовые звонки работают.
Выбор модели и поддержки русского/казахского зависит от настроенного провайдера.

## Контракт

- `POST /calls` → `{ "callId": "..." }`
- `POST /calls/{callId}/turns` с `{ "text": "..." }` → объект `Dialog`
- `POST /calls/{callId}/end`
- `GET /dialogs`, `GET /dialogs/{id}` — сохранённые реплики
- `GET /scenarios`, `PUT /scenarios/{id}` — каталог; изменения применяются к следующему вызову роутера
- `WS /ws?callId=...` — события `status`, `transcript`, `route`, `route_decision`,
  `reply`, `tts_audio`, `trace`, `dialog`, `error`.

Клиент может отправить `text_input {text}` по WebSocket или через REST. Аудио: несколько
`audio_chunk {pcm16: "base64", sample_rate: 16000}` (signed PCM16 mono), затем `speech_end`.
Максимум 30 секунд на реплику. `tts_audio` содержит base64 WAV в поле `chunk`. Событие
`dialog` завершает реплику. Все задержки в `trace.timings_ms` измеряются на сервере;
`playback` браузера сервер измерить не может. WebSocket также посылает события с полями,
которые ожидает текущий frontend `realApi.ts` из `main`.
В записи диалога сохраняются публичный `route` и полный валидированный `routerResult`;
при передаче оператору добавляется `handoffCard` с контекстом.

`PUT /scenarios/{id}` принимает `id`, `name`, `description`, `boundaries`, `examplesRu`,
`examplesKk`. Файл каталога сохраняется атомарно. Новые сценарии получают безопасные пустые
`actions`; API не позволяет запускать бизнес-действия. Данные SQLite живут в Docker volume.

Тесты: `PYTHONPATH=backend pytest backend/tests -q`.
