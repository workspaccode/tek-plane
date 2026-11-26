"""Site administration: overview, users, projects, activity and system health. Admins only."""

import platform
from datetime import timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import config, github_app, mailer
from .. import models as m
from ..db import get_db
from ..realtime import hub
from ..security import admin_user, is_admin
from ..serializers import activity_out, iso, user_out

router = APIRouter(prefix="/api/admin", tags=["admin"])

STARTED_AT = m.utcnow()
VERSION = "0.1.0"


class UserPatch(BaseModel):
    is_admin: bool | None = None
    disabled: bool | None = None


class TestEmailIn(BaseModel):
    to: str | None = Field(None, max_length=255)


# ---------------------------------------------------------------- helpers

def _n(db: Session, stmt) -> int:
    return int(db.scalar(stmt) or 0)


def _admin_filter():
    cond = m.User.is_admin.is_(True)
    if config.ADMIN_EMAILS:
        cond = or_(cond, func.lower(m.User.email).in_(config.ADMIN_EMAILS))
    return cond


def _per_day(db: Session, column, days: int = 30, where=None) -> list[dict]:
    """Counts per UTC day for the last `days` days, oldest first, with empty days filled in."""
    first = (m.utcnow() - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    stmt = select(func.date(column), func.count()).where(column >= first)
    if where is not None:
        stmt = stmt.where(where)
    rows = dict(db.execute(stmt.group_by(func.date(column))).all())
    out = []
    for i in range(days):
        day = (first + timedelta(days=i)).date().isoformat()
        out.append({"date": day, "count": int(rows.get(day, 0))})
    return out


def _grouped(db: Session, key, where=None) -> dict[int, int]:
    stmt = select(key, func.count()).where(key.is_not(None))
    if where is not None:
        stmt = stmt.where(where)
    return {k: int(v) for k, v in db.execute(stmt.group_by(key)).all()}


def _user_stats(db: Session) -> dict[str, dict[int, int]]:
    return {
        "projects": _grouped(db, m.ProjectMember.user_id),
        "owned": _grouped(db, m.Project.owner_id),
        "open_tasks": _grouped(db, m.Task.assignee_id, m.Task.status == "open"),
        "created_tasks": _grouped(db, m.Task.creator_id),
    }


def _protected(u: m.User) -> bool:
    """Admins from TEKPLANE_ADMIN_EMAILS and password admin accounts can't be demoted or suspended here."""
    return u.email.lower() in config.ADMIN_EMAILS or bool(u.password_hash and u.is_admin)


def admin_user_out(u: m.User, stats: dict | None = None, online: set[int] | None = None) -> dict:
    stats = stats or {}
    return {
        **user_out(u),
        "google_linked": bool(u.google_sub),
        "is_admin": is_admin(u),
        "protected": _protected(u),
        "has_password": bool(u.password_hash),
        "disabled": bool(u.disabled),
        "online": u.id in (online if online is not None else set(hub.online_user_ids())),
        "last_seen_at": iso(u.last_seen_at),
        "last_login_at": iso(u.last_login_at),
        "created_at": iso(u.created_at),
        "projects": stats.get("projects", {}).get(u.id, 0),
        "owned_projects": stats.get("owned", {}).get(u.id, 0),
        "open_tasks": stats.get("open_tasks", {}).get(u.id, 0),
        "created_tasks": stats.get("created_tasks", {}).get(u.id, 0),
    }


def _project_mini(p: m.Project) -> dict:
    return {"id": p.id, "name": p.name, "color": p.color, "icon": p.icon, "kind": p.kind or "board"}


def _dir_size(path: Path) -> tuple[int, int]:
    if not path.exists():
        return 0, 0
    files = [f for f in path.rglob("*") if f.is_file()]
    return sum(f.stat().st_size for f in files), len(files)


def _db_size() -> int | None:
    url = config.DATABASE_URL
    if not url.startswith("sqlite:///"):
        return None
    base = Path(url[len("sqlite:///"):])
    return sum(p.stat().st_size for p in (base, Path(f"{base}-wal"), Path(f"{base}-shm")) if p.exists())


def _target(db: Session, user_id: int) -> m.User:
    u = db.get(m.User, user_id)
    if not u:
        raise HTTPException(404, "User not found")
    return u


# ---------------------------------------------------------------- overview

@router.get("/overview")
def overview(_: m.User = Depends(admin_user), db: Session = Depends(get_db)):
    now = m.utcnow()
    day, week = now - timedelta(days=1), now - timedelta(days=7)
    online = set(hub.online_user_ids())
    U, P, T = m.User, m.Project, m.Task

    users = {
        "total": _n(db, select(func.count(U.id))),
        "new_week": _n(db, select(func.count(U.id)).where(U.created_at >= week)),
        "active_day": _n(db, select(func.count(U.id)).where(U.last_seen_at >= day)),
        "active_week": _n(db, select(func.count(U.id)).where(U.last_seen_at >= week)),
        "online": len(online),
        "verified": _n(db, select(func.count(U.id)).where(U.email_verified.is_(True))),
        "google": _n(db, select(func.count(U.id)).where(U.google_sub.is_not(None))),
        "admins": _n(db, select(func.count(U.id)).where(_admin_filter())),
        "suspended": _n(db, select(func.count(U.id)).where(U.disabled.is_(True))),
    }
    projects = {
        "total": _n(db, select(func.count(P.id))),
        "boards": _n(db, select(func.count(P.id)).where(P.kind != "mindmap")),
        "mindmaps": _n(db, select(func.count(P.id)).where(P.kind == "mindmap")),
        "archived": _n(db, select(func.count(P.id)).where(P.archived.is_(True))),
        "new_week": _n(db, select(func.count(P.id)).where(P.created_at >= week)),
    }
    tasks = {
        "total": _n(db, select(func.count(T.id)).where(T.status != "archived")),
        "open": _n(db, select(func.count(T.id)).where(T.status == "open")),
        "completed": _n(db, select(func.count(T.id)).where(T.status == "completed")),
        "overdue": _n(db, select(func.count(T.id)).where(T.status == "open", T.due_date < now)),
        "created_week": _n(db, select(func.count(T.id)).where(T.created_at >= week)),
        "completed_week": _n(db, select(func.count(T.id)).where(T.completed_at >= week)),
    }
    content = {
        "mind_maps": _n(db, select(func.count(m.MindMap.id))),
        "mind_nodes": _n(db, select(func.count(m.MindNode.id))),
        "comments": _n(db, select(func.count(m.Comment.id))),
        "attachments": _n(db, select(func.count(m.Attachment.id))),
        "attachment_bytes": _n(db, select(func.sum(m.Attachment.size))),
        "tracked_seconds": _n(db, select(func.sum(m.TimeEntry.duration_seconds))),
    }

    recent = db.scalars(select(U).order_by(U.created_at.desc()).limit(6)).all()
    top_rows = db.execute(
        select(P, func.count(m.Activity.id).label("n"))
        .join(m.Activity, m.Activity.project_id == P.id)
        .where(m.Activity.created_at >= now - timedelta(days=30))
        .group_by(P.id).order_by(func.count(m.Activity.id).desc()).limit(5)
    ).all()

    return {
        "users": users,
        "projects": projects,
        "tasks": tasks,
        "content": content,
        "signups": _per_day(db, U.created_at),
        "activity": _per_day(db, m.Activity.created_at),
        "completed": _per_day(db, T.completed_at),
        "recent_users": [admin_user_out(u, online=online) for u in recent],
        "top_projects": [{**_project_mini(p), "events": n} for p, n in top_rows],
        "health": {
            "email": mailer.provider(),
            "google": bool(config.GOOGLE_CLIENT_ID and config.GOOGLE_CLIENT_SECRET),
            "uptime_seconds": int((now - STARTED_AT).total_seconds()),
        },
    }


# ---------------------------------------------------------------- users

@router.get("/users")
def list_users(q: str = "", filter: str = "all", _: m.User = Depends(admin_user), db: Session = Depends(get_db)):
    stmt = select(m.User)
    q = q.strip().lower()
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(func.lower(m.User.email).like(like), func.lower(m.User.name).like(like)))
    online = set(hub.online_user_ids())
    if filter == "admins":
        stmt = stmt.where(_admin_filter())
    elif filter == "suspended":
        stmt = stmt.where(m.User.disabled.is_(True))
    elif filter == "unverified":
        stmt = stmt.where(m.User.email_verified.is_(False))
    elif filter == "google":
        stmt = stmt.where(m.User.google_sub.is_not(None))
    elif filter == "online":
        stmt = stmt.where(m.User.id.in_(online or {-1}))
    stats = _user_stats(db)
    rows = db.scalars(stmt.order_by(m.User.created_at.desc()).limit(1000)).all()
    return [admin_user_out(u, stats, online) for u in rows]


@router.get("/users/{user_id}")
def user_detail(user_id: int, _: m.User = Depends(admin_user), db: Session = Depends(get_db)):
    u = _target(db, user_id)
    memberships = db.execute(
        select(m.ProjectMember, m.Project).join(m.Project, m.Project.id == m.ProjectMember.project_id)
        .where(m.ProjectMember.user_id == u.id).order_by(m.Project.name)
    ).all()
    acts = db.execute(
        select(m.Activity, m.Project).join(m.Project, m.Project.id == m.Activity.project_id)
        .where(m.Activity.user_id == u.id).order_by(m.Activity.id.desc()).limit(15)
    ).all()
    return {
        **admin_user_out(u, _user_stats(db)),
        "title": u.title,
        "tracked_seconds": _n(db, select(func.sum(m.TimeEntry.duration_seconds)).where(m.TimeEntry.user_id == u.id)),
        "comments": _n(db, select(func.count(m.Comment.id)).where(m.Comment.user_id == u.id)),
        "completed_tasks": _n(db, select(func.count(m.Task.id)).where(m.Task.assignee_id == u.id,
                                                                         m.Task.status == "completed")),
        "project_list": [{**_project_mini(p), "role": pm.role, "archived": p.archived} for pm, p in memberships],
        "activity": [{**activity_out(a), "project": _project_mini(p)} for a, p in acts],
    }


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: UserPatch, me: m.User = Depends(admin_user), db: Session = Depends(get_db)):
    u = _target(db, user_id)
    protected = _protected(u)
    if body.is_admin is not None:
        if not body.is_admin and u.id == me.id:
            raise HTTPException(400, "You can't remove your own admin access.")
        if not body.is_admin and protected:
            raise HTTPException(400, "This admin is protected: it's set in .env or signs in with a password.")
        u.is_admin = body.is_admin
    if body.disabled is not None:
        if body.disabled and u.id == me.id:
            raise HTTPException(400, "You can't suspend your own account.")
        if body.disabled and protected:
            raise HTTPException(400, "This admin is protected and can't be suspended.")
        u.disabled = body.disabled
    db.commit()
    if body.disabled:
        hub.publish([u.id], {"type": "session.revoked", "data": {"reason": "suspended"}})
    return admin_user_out(u, _user_stats(db))


@router.post("/users/{user_id}/signout")
def sign_out_everywhere(user_id: int, me: m.User = Depends(admin_user), db: Session = Depends(get_db)):
    u = _target(db, user_id)
    if u.id == me.id:
        raise HTTPException(400, "Use Log out to end your own session.")
    # tokens carry whole-second iat; round up so a token issued this second is revoked too
    u.sessions_revoked_at = (m.utcnow() + timedelta(seconds=1)).replace(microsecond=0)
    db.commit()
    hub.publish([u.id], {"type": "session.revoked", "data": {"reason": "signed_out"}})
    return {"ok": True}


# ---------------------------------------------------------------- projects

@router.get("/projects")
def list_projects(q: str = "", me: m.User = Depends(admin_user), db: Session = Depends(get_db)):
    stmt = select(m.Project)
    if q.strip():
        stmt = stmt.where(func.lower(m.Project.name).like(f"%{q.strip().lower()}%"))
    projects = db.scalars(stmt.order_by(m.Project.updated_at.desc()).limit(1000)).all()
    members = _grouped(db, m.ProjectMember.project_id)
    total = _grouped(db, m.Task.project_id, m.Task.status != "archived")
    open_ = _grouped(db, m.Task.project_id, m.Task.status == "open")
    nodes = dict(db.execute(select(m.MindMap.project_id, func.count(m.MindNode.id))
                            .join(m.MindNode, m.MindNode.map_id == m.MindMap.id).group_by(m.MindMap.project_id)).all())
    last = dict(db.execute(select(m.Activity.project_id, func.max(m.Activity.created_at))
                           .group_by(m.Activity.project_id)).all())
    mine = set(db.scalars(select(m.ProjectMember.project_id).where(m.ProjectMember.user_id == me.id)))
    owners = {u.id: u for u in db.scalars(select(m.User).where(m.User.id.in_({p.owner_id for p in projects} or {-1})))}
    return [{
        **_project_mini(p),
        "archived": p.archived,
        "owner": user_out(owners.get(p.owner_id)),
        "members": members.get(p.id, 0),
        "tasks": total.get(p.id, 0),
        "open_tasks": open_.get(p.id, 0),
        "nodes": int(nodes.get(p.id, 0)),
        "last_activity_at": iso(last.get(p.id)),
        "created_at": iso(p.created_at),
        "is_member": p.id in mine,
    } for p in projects]


@router.delete("/projects/{project_id}")
def delete_project(project_id: int, me: m.User = Depends(admin_user), db: Session = Depends(get_db)):
    p = db.get(m.Project, project_id)
    if not p:
        raise HTTPException(404, "Project not found")
    audience = [x.user_id for x in p.members]
    stored = list(db.scalars(
        select(m.Attachment.stored_name).join(m.Task, m.Task.id == m.Attachment.task_id)
        .where(m.Task.project_id == project_id)
    ))
    db.delete(p)
    db.commit()
    for name in stored:
        (config.UPLOAD_DIR / name).unlink(missing_ok=True)
    hub.publish(audience, {"type": "project.deleted", "project_id": project_id, "actor_id": me.id, "data": {}})
    return {"ok": True}


# ---------------------------------------------------------------- activity

@router.get("/activity")
def activity(before: int | None = None, limit: int = 50, _: m.User = Depends(admin_user),
             db: Session = Depends(get_db)):
    stmt = select(m.Activity, m.Project).join(m.Project, m.Project.id == m.Activity.project_id)
    if before:
        stmt = stmt.where(m.Activity.id < before)
    rows = db.execute(stmt.order_by(m.Activity.id.desc()).limit(max(1, min(limit, 100)))).all()
    return [{**activity_out(a), "project": _project_mini(p)} for a, p in rows]


# ---------------------------------------------------------------- system

@router.get("/system")
def system(request: Request, _: m.User = Depends(admin_user), db: Session = Depends(get_db)):
    base = config.BASE_URL or str(request.base_url).rstrip("/")
    uploads_bytes, uploads_files = _dir_size(config.UPLOAD_DIR)
    admins = db.scalars(select(m.User).where(_admin_filter()).order_by(m.User.email)).all()
    registered = {u.email.lower() for u in admins}
    provider = mailer.provider()
    return {
        "email": {
            "provider": provider,
            "from": mailer.sender() if provider != "console" else None,
            "host": f"{config.SMTP_HOST}:{config.SMTP_PORT}" if provider == "smtp" else None,
        },
        "google": {
            "configured": bool(config.GOOGLE_CLIENT_ID and config.GOOGLE_CLIENT_SECRET),
            "redirect_uri": f"{base}/api/auth/google/callback",
        },
        "network": {"base_url": config.BASE_URL or None, "current_url": base},
        "github_app": {
            "configured": github_app.configured(),
            "app_id": config.GITHUB_APP_ID or None,
            "slug": config.GITHUB_APP_SLUG or None,
            "key_found": bool(github_app.private_key()),
            "oauth_ready": github_app.oauth_ready(),
            "client_id_set": bool(config.GITHUB_APP_CLIENT_ID),
            "client_secret_set": bool(config.GITHUB_APP_CLIENT_SECRET),
            "callback_url": f"{base}/api/integrations/github/callback",
            "linked_accounts": _n(db, select(func.count(m.GithubAccount.id))),
            "webhook_url": f"{base}/api/integrations/github/webhook" if config.GITHUB_WEBHOOK_SECRET else None,
            "connected_repos": _n(db, select(func.count(m.Integration.id)).where(m.Integration.provider == "github")),
        },
        "admins": [user_out(u) | {"from_config": u.email.lower() in config.ADMIN_EMAILS,
                                  "has_password": bool(u.password_hash)} for u in admins],
        "pending_admin_emails": sorted(config.ADMIN_EMAILS - registered),
        "storage": {
            "database_bytes": _db_size(),
            "uploads_bytes": uploads_bytes,
            "uploads_files": uploads_files,
            "data_dir": str(config.DATA_DIR),
        },
        "runtime": {
            "version": VERSION,
            "python": platform.python_version(),
            "platform": f"{platform.system()} {platform.release()}",
            "started_at": iso(STARTED_AT),
            "uptime_seconds": int((m.utcnow() - STARTED_AT).total_seconds()),
            "connections": sum(len(c) for c in hub.connections.values()),
        },
        "security": {
            "otp_ttl_minutes": config.OTP_TTL_MINUTES,
            "otp_max_attempts": config.OTP_MAX_ATTEMPTS,
            "session_days": round(config.TOKEN_TTL_HOURS / 24, 1),
            "pending_codes": _n(db, select(func.count(m.OtpCode.id)).where(
                m.OtpCode.consumed.is_(False), m.OtpCode.expires_at > m.utcnow())),
        },
    }


@router.post("/system/test-email")
def test_email(body: TestEmailIn, me: m.User = Depends(admin_user)):
    to = (body.to or me.email).strip().lower()
    try:
        mailer.deliver(to, "6dx test email",
                       "This is a test email from the 6dx admin panel. Email delivery works.",
                       "<p>This is a test email from the <b>6dx</b> admin panel.</p><p>Email delivery works. ✅</p>")
    except Exception as exc:  # report the provider's error to the admin
        raise HTTPException(502, f"Sending failed: {mailer._hint(exc)}") from exc
    return {"ok": True, "to": to, "provider": mailer.provider()}
