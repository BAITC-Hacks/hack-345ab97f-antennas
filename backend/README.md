# Backend: текстовый сквозной путь

Реплика (текст) → LLM-роутер → policy → исполнитель → ответ и трассировка на экране. Сервер
реализует контракт `frontend/src/api/realApi.ts`; фронтенд не менялся. Голос (STT/TTS) пока
не подключён: это следующий шаг, он встаёт вокруг `CallSession.handle_turn()`.

## Запуск

Из корня репозитория, в двух терминалах:

```bash
python -m venv .venv && .venv\Scripts\activate      # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env                               # вписать LLM_API_KEY и LLM_MODEL
python -m uvicorn app.main:app --app-dir backend --port 8000        # или: make run
```

```bash
cd frontend
npm ci
copy .env.example .env      # затем VITE_DEMO_MODE=false
npm run dev                 # http://localhost:5173/call, или: make web
```

Проверка сервера: `http://localhost:8000/health`, документация API: `http://localhost:8000/docs`.

## API

| Метод | Путь | Что делает |
| --- | --- | --- |
| GET | `/scenarios` | Каталог в форме фронтенда (`Scenario`) |
| PUT | `/scenarios/{id}` | Создать/изменить сценарий; роутер видит его со следующей реплики |
| GET | `/dialogs`, `/dialogs/{id}` | История реплик (`Dialog`), новые сверху |
| POST | `/calls` | Начать звонок → `{callId}` |
| POST | `/calls/{id}/turns` | `{text}` → обработать реплику, вернуть `Dialog` |
| POST | `/calls/{id}/end` | Завершить звонок |
| WS | `/ws?callId=…` | События `status`, `transcript`, `route`, `reply`, затем `dialog` |

## Устройство

- `app/main.py` — FastAPI, REST и WebSocket, CORS для Vite.
- `app/dialog/manager.py` — состояние звонка (`DialogState`), `router.route()` → `policy.apply()`,
  исполнитель-заглушка: отвечает `response_example` сценария, реальных действий не выполняет.
  Фиксированные ответы на казахском нужно проверить носителю языка.
- `app/trace/store.py` — диалоги в SQLite (`var/voice_router.sqlite3`).
- `app/api/catalog.py` — каталог ↔ форма фронтенда. Редактор пишет в `var/scenarios.json`
  (копия `data/scenarios.json` при первом старте): `data/` — стартовый кит и не редактируется.

В трассировке заполнены только измеренные этапы: `route`, `exec`, `total`. Остальные (`stt`,
`firstAudio`, …) отсутствуют, интерфейс показывает «нет данных», а не 0. Уверенность у
альтернатив и дополнительных намерений не измеряется и приходит как `null` (в интерфейсе «—»).
