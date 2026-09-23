# hack-345ab97f-antennas
Hackathon team repository for Antennas <br>
My name is Saruar

## Voice Router · Frontend

Пакет участника 3 находится в [voice-router-frontend](./voice-router-frontend/README.md): экран звонка, трассировка, супервизор, каталог, серверный OpenAI smoke-test и материалы для питча.

Запуск (Node.js 20+):

```powershell
cd voice-router-frontend
node server.mjs
```

Откройте http://127.0.0.1:8787. Проверки: `node --test`.
Ключи не входят в репозиторий. Демо-метрики синтетические; статус интеграций указан в [CONFORMANCE.md](./voice-router-frontend/CONFORMANCE.md).

## Voice Router · Backend

Сервер находится в отдельной папке [voice-router-backend](./voice-router-backend/README.md).
Он отдаёт frontend, принимает WebSocket, сохраняет каталог/историю и предоставляет API супервизора.

```powershell
cd voice-router-backend
node src/server.mjs
```

Откройте http://127.0.0.1:8000 — Gateway подключается автоматически.
На чистом компьютере сначала выполните `pnpm install --frozen-lockfile` (или `npm install --ignore-scripts`).
По умолчанию работает demo без ключа. Для LLM и речи настройте **voice-router-backend/.env** по инструкции в его README.
Тесты backend: `node --test`; ключ и платные запросы не нужны.
