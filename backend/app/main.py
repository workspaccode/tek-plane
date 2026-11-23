import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from . import models as m
from .config import FRONTEND_DIR
from .db import Base, SessionLocal, engine
from .realtime import hub
from .routers import auth, mindmaps, personal, projects, sections, tasks
from .security import user_from_token


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    hub.bind_loop(asyncio.get_running_loop())
    yield


app = FastAPI(title="tek-plane", version="0.1.0", lifespan=lifespan)

for r in (auth, projects, sections, tasks, mindmaps, personal):
    app.include_router(r.router)


@app.get("/api/health")
def health():
    return {"ok": True}


def _project_audience(user_id: int) -> set[int]:
    with SessionLocal() as db:
        pids = select(m.ProjectMember.project_id).where(m.ProjectMember.user_id == user_id)
        return set(db.scalars(select(m.ProjectMember.user_id).where(m.ProjectMember.project_id.in_(pids))))


@app.websocket("/ws")
async def websocket(ws: WebSocket, token: str = ""):
    with SessionLocal() as db:
        user = user_from_token(db, token)
    if not user:
        await ws.close(code=4401)
        return
    await hub.connect(user.id, ws)
    hub.publish(_project_audience(user.id), {"type": "presence", "data": {"user_id": user.id, "online": True}})
    try:
        while True:
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_text('{"type":"pong"}')
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(user.id, ws)
        if user.id not in hub.connections:
            hub.publish(_project_audience(user.id), {"type": "presence", "data": {"user_id": user.id, "online": False}})


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path.startswith("api/"):
        from fastapi import HTTPException

        raise HTTPException(404, "Not found")
    return FileResponse(FRONTEND_DIR / "index.html")
