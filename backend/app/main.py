import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, select, text

from . import models as m
from .config import FRONTEND_DIR
from .db import Base, SessionLocal, engine
from .realtime import hub
from .routers import admin, auth, integrations, mindmaps, personal, projects, sections, tasks
from .security import user_from_token


def _migrate() -> None:
    """Small additive migrations for databases created by earlier versions."""
    insp = inspect(engine)
    tables = insp.get_table_names()
    if "projects" in tables and "kind" not in {c["name"] for c in insp.get_columns("projects")}:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE projects ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'board'"))
    if "projects" in tables and "category" not in {c["name"] for c in insp.get_columns("projects")}:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE projects ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT 'general'"))
    if "tasks" in tables:
        task_cols = {c["name"] for c in insp.get_columns("tasks")}
        with engine.begin() as conn:
            if "external_url" not in task_cols:
                conn.execute(text("ALTER TABLE tasks ADD COLUMN external_url VARCHAR(500)"))
            if "external_ref" not in task_cols:
                conn.execute(text("ALTER TABLE tasks ADD COLUMN external_ref VARCHAR(160)"))
                conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_external_ref ON tasks (external_ref)"))
    if "mind_maps" in tables and "settings" not in {c["name"] for c in insp.get_columns("mind_maps")}:
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE mind_maps ADD COLUMN settings JSON"))
    if "users" in tables:
        cols = {c["name"] for c in insp.get_columns("users")}
        with engine.begin() as conn:
            if "google_sub" not in cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN google_sub VARCHAR(64)"))
                conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_google_sub ON users (google_sub)"))
            if "avatar_url" not in cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500)"))
            if "email_verified" not in cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT 0"))
            for col, ddl in (("is_admin", "BOOLEAN NOT NULL DEFAULT 0"), ("disabled", "BOOLEAN NOT NULL DEFAULT 0"),
                             ("last_seen_at", "DATETIME"), ("last_login_at", "DATETIME"),
                             ("sessions_revoked_at", "DATETIME")):
                if col not in cols:
                    conn.execute(text(f"ALTER TABLE users ADD COLUMN {col} {ddl}"))
            if "username" not in cols:
                conn.execute(text("ALTER TABLE users ADD COLUMN username VARCHAR(60)"))
                conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username)"))


@asynccontextmanager
async def lifespan(_: FastAPI):
    _migrate()
    Base.metadata.create_all(engine)
    hub.bind_loop(asyncio.get_running_loop())
    yield


app = FastAPI(title="6dx", version="0.1.0", lifespan=lifespan)

for r in (auth, projects, sections, tasks, mindmaps, personal, admin, integrations):
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


class RevalidatingStaticFiles(StaticFiles):
    """Browsers must re-check CSS/JS on every load (cheap 304s), so updates show up without a hard refresh."""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/static", RevalidatingStaticFiles(directory=FRONTEND_DIR), name="static")


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path.startswith("api/"):
        from fastapi import HTTPException

        raise HTTPException(404, "Not found")
    return FileResponse(FRONTEND_DIR / "index.html")
