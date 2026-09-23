"""FastAPI server: REST + WebSocket for the frontend (contract: frontend/src/api/realApi.ts).

Run from the repo root:  uvicorn app.main:app --app-dir backend --port 8001
(port 8000 belongs to the Node gateway, which calls POST /gateway/route here in ROUTER_MODE=python)
"""
from __future__ import annotations

import os
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Response, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .api.catalog import ScenarioIn, list_scenarios, save_scenario
from .api.gateway import GatewayRouteIn, gateway_route
from .dialog import CallSession
from .router import LLMRouter
from .trace import DialogStore

ROOT = Path(__file__).resolve().parents[2]


class TurnIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


def create_app(router: LLMRouter | None = None, var_dir: Path | None = None) -> FastAPI:
    sessions: dict[str, CallSession] = {}
    sockets: dict[str, set[WebSocket]] = {}
    ctx: dict[str, Any] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        load_dotenv(ROOT / ".env")
        var = var_dir or ROOT / os.getenv("APP_VAR_DIR", "var")
        var.mkdir(parents=True, exist_ok=True)
        # data/ is the starter kit and stays read-only: the catalog editor works on a copy in var/.
        catalog_path = var / "scenarios.json"
        if not catalog_path.exists():
            shutil.copyfile(ROOT / os.getenv("ROUTER_CATALOG_PATH", "data/scenarios.json"), catalog_path)
        live_router = router or LLMRouter(catalog_path=catalog_path)
        live_router.catalog_path = catalog_path
        await live_router.warm_up()
        ctx.update(router=live_router, catalog=catalog_path, store=DialogStore(var / "voice_router.sqlite3"))
        yield

    app = FastAPI(title="Voice Router", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
        allow_methods=["*"],
        allow_headers=["*"],
    )

    async def emit(call_id: str, event: dict[str, Any]) -> None:
        for socket in list(sockets.get(call_id, ())):
            try:
                await socket.send_json(event)
            except Exception:  # a dead socket must not break the turn
                sockets[call_id].discard(socket)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok", "model": ctx["router"].provider.model, "scenarios": len(list_scenarios(ctx["catalog"]))}

    @app.post("/gateway/route")
    async def route_for_gateway(request: GatewayRouteIn) -> dict[str, Any]:
        """Decision for voice-router-backend (ROUTER_MODE=python): its catalog, its session, our router."""
        try:
            return await gateway_route(ctx["router"], request)
        except ValueError as error:  # invalid catalog snapshot (duplicate/empty ids)
            raise HTTPException(422, str(error)) from error
        except Exception as error:
            raise HTTPException(502, f"Роутер не ответил: {type(error).__name__}") from error

    @app.get("/scenarios")
    async def get_scenarios() -> list[dict[str, Any]]:
        return list_scenarios(ctx["catalog"])

    @app.put("/scenarios/{scenario_id}")
    async def put_scenario(scenario_id: str, scenario: ScenarioIn) -> dict[str, Any]:
        if scenario.id != scenario_id:
            raise HTTPException(422, "id в пути и в теле не совпадают")
        try:
            return save_scenario(ctx["catalog"], scenario)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    @app.get("/dialogs")
    async def get_dialogs() -> list[dict[str, Any]]:
        return ctx["store"].list()

    @app.get("/dialogs/{dialog_id}")
    async def get_dialog(dialog_id: str) -> dict[str, Any]:
        dialog = ctx["store"].get(dialog_id)
        if dialog is None:
            raise HTTPException(404, "Диалог не найден")
        return dialog

    @app.post("/calls")
    async def start_call() -> dict[str, str]:
        call_id = f"call-{uuid.uuid4().hex[:12]}"
        sessions[call_id] = CallSession(call_id, ctx["router"])
        return {"callId": call_id}

    @app.post("/calls/{call_id}/turns")
    async def post_turn(call_id: str, turn: TurnIn) -> dict[str, Any]:
        session = sessions.get(call_id)
        if session is None:
            raise HTTPException(404, "Звонок не найден или уже завершён")

        async def send(event: dict[str, Any]) -> None:
            await emit(call_id, event)

        try:
            dialog = await session.handle_turn(turn.text.strip(), send)
        except Exception as error:
            await emit(call_id, {"type": "status", "status": "error"})
            raise HTTPException(502, f"Роутер не ответил: {type(error).__name__}") from error
        ctx["store"].save(call_id, dialog)  # saved before the answer, as database/README.md requires
        await emit(call_id, {"type": "dialog", "dialog": dialog})
        return dialog

    @app.post("/calls/{call_id}/end", status_code=204)
    async def end_call(call_id: str) -> Response:
        sessions.pop(call_id, None)
        for socket in sockets.pop(call_id, set()):
            await socket.close()
        return Response(status_code=204)

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket, callId: str) -> None:
        if callId not in sessions:
            await websocket.close(code=4404)
            return
        await websocket.accept()
        sockets.setdefault(callId, set()).add(websocket)
        try:
            while True:
                await websocket.receive_text()  # the client only listens; this keeps the socket open
        except WebSocketDisconnect:
            sockets.get(callId, set()).discard(websocket)

    return app


app = create_app()
