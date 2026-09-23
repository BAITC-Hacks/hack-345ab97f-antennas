# Backend: Python LLM-роутер как сервис

Python-сервер принимает решения для всей системы. Основной вход — Node-шлюз
`voice-router-backend/` (голос, интерфейс, каталог, очередь handoff): в режиме `ROUTER_MODE=python`
он на каждую реплику вызывает `POST /gateway/route`. Дополнительно сервер реализует контракт
React-фронтенда `frontend/src/api/realApi.ts` (текстовый путь, фронтенд не менялся).

```
Браузер ──WS──▶ Node Gateway :8000 ──POST /gateway/route──▶ Python :8001 ──▶ LLM (OpenAI)
  (voice-router-frontend)   STT/TTS, каталог, история        router.route → policy → ответ
```

## Запуск всей системы

Из корня репозитория, в двух терминалах:

```bash
python -m venv .venv && .venv\Scripts\activate      # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env                               # вписать LLM_API_KEY и LLM_MODEL
python -m uvicorn app.main:app --app-dir backend --port 8001        # или: make run
```

```powershell
cd voice-router-backend
npm install --ignore-scripts        # или: pnpm install --frozen-lockfile
$env:ROUTER_MODE='python'; node src/server.mjs                      # или: make gateway
```

Откройте **http://127.0.0.1:8000**. Проверка Python-сервера: `http://127.0.0.1:8001/health`,
документация API: `http://127.0.0.1:8001/docs`.

React-фронтенд напрямую к Python-серверу (без голоса): в `frontend/.env` задайте
`VITE_DEMO_MODE=false`, `VITE_API_URL=http://localhost:8001`, `VITE_WS_URL=ws://localhost:8001/ws`,
затем `cd frontend && npm run dev` (`make web`), адрес http://localhost:5173/call.

## API

| Метод | Путь | Что делает |
| --- | --- | --- |
| POST | `/gateway/route` | Для Node-шлюза: `{text, catalog, session}` → решение в формате его `validateDecision` |
| GET | `/scenarios` | Каталог в форме React-фронтенда (`Scenario`) |
| PUT | `/scenarios/{id}` | Создать/изменить сценарий; роутер видит его со следующей реплики |
| GET | `/dialogs`, `/dialogs/{id}` | История реплик (`Dialog`), новые сверху |
| POST | `/calls` | Начать звонок → `{callId}` |
| POST | `/calls/{id}/turns` | `{text}` → обработать реплику, вернуть `Dialog` |
| POST | `/calls/{id}/end` | Завершить звонок |
| WS | `/ws?callId=…` | События `status`, `transcript`, `route`, `reply`, затем `dialog` |

## Устройство

- `app/api/gateway.py` — мост для Node-шлюза. Шлюз присылает свой каталог и сессию; наши пять
  действий переводятся в его три: `continue` → `route`, `out_of_scope` → `handoff`. Измерена только
  уверенность основного выбора: у альтернатив — оценка «уверенность − запас», у очереди — уверенность реплики.
- `app/main.py` — FastAPI, REST и WebSocket, CORS для Vite.
- `app/dialog/manager.py` — состояние звонка (`DialogState`), `router.route()` → `policy.apply()`,
  исполнитель-заглушка: отвечает `response_example` сценария (или нейтральной фразой, если его нет),
  реальных действий не выполняет. Фиксированные ответы на казахском нужно проверить носителю языка.
- `app/trace/store.py` — диалоги React-пути в SQLite (`var/voice_router.sqlite3`).
- `app/api/catalog.py` — каталог ↔ форма React-фронтенда. Редактор пишет в `var/scenarios.json`
  (копия `data/scenarios.json` при первом старте): `data/` — стартовый кит и не редактируется.

В трассировке React-пути заполнены только измеренные этапы: `route`, `exec`, `total`. Остальные
(`stt`, `firstAudio`, …) отсутствуют, интерфейс показывает «нет данных», а не 0.
