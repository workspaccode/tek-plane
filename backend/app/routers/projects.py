import re
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from .. import config, mailer
from .. import models as m
from ..config import UPLOAD_DIR
from ..db import get_db
from ..realtime import hub
from ..security import current_user
from ..serializers import (
    activity_out,
    member_out,
    project_out,
    section_out,
    tag_out,
    task_summaries,
)
from ..services import (
    DEFAULT_TAGS,
    ROLES,
    TEMPLATES,
    apply_template,
    broadcast,
    get_or_create_user,
    log,
    membership,
    notify,
    require_role,
)

router = APIRouter(prefix="/api", tags=["projects"])
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    color: str = "#4f7cff"
    icon: str = "folder"
    template: str = "kanban"


class ProjectPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=160)
    description: str | None = None
    color: str | None = None
    icon: str | None = None
    archived: bool | None = None


class MemberIn(BaseModel):
    email: str
    role: str = "member"


class MemberPatch(BaseModel):
    role: str


@router.get("/templates")
def templates():
    return [{"id": k, "sections": [s[0] for s in v]} for k, v in TEMPLATES.items()]


@router.get("/projects")
def list_projects(user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(m.Project, m.ProjectMember.role)
        .join(m.ProjectMember, m.ProjectMember.project_id == m.Project.id)
        .where(m.ProjectMember.user_id == user.id)
        .order_by(m.Project.archived, m.Project.name)
    ).all()
    ids = [p.id for p, _ in rows]
    open_counts = dict(db.execute(
        select(m.Task.project_id, func.count(m.Task.id))
        .where(m.Task.project_id.in_(ids), m.Task.status == "open").group_by(m.Task.project_id)
    ).all()) if ids else {}
    done_counts = dict(db.execute(
        select(m.Task.project_id, func.count(m.Task.id))
        .where(m.Task.project_id.in_(ids), m.Task.status == "completed").group_by(m.Task.project_id)
    ).all()) if ids else {}
    member_counts = dict(db.execute(
        select(m.ProjectMember.project_id, func.count(m.ProjectMember.id))
        .where(m.ProjectMember.project_id.in_(ids)).group_by(m.ProjectMember.project_id)
    ).all()) if ids else {}
    members_by_project: dict[int, list] = {}
    if ids:
        for pm in db.scalars(
            select(m.ProjectMember).options(selectinload(m.ProjectMember.user))
            .where(m.ProjectMember.project_id.in_(ids))
        ):
            members_by_project.setdefault(pm.project_id, []).append(member_out(pm))
    return [
        {
            **project_out(p, role),
            "open_tasks": open_counts.get(p.id, 0),
            "completed_tasks": done_counts.get(p.id, 0),
            "member_count": member_counts.get(p.id, 0),
            "members": members_by_project.get(p.id, [])[:6],
        }
        for p, role in rows
    ]


@router.post("/projects")
def create_project(body: ProjectIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    p = m.Project(name=body.name.strip(), description=body.description, color=body.color,
                  icon=body.icon, owner_id=user.id)
    db.add(p)
    db.flush()
    db.add(m.ProjectMember(project_id=p.id, user_id=user.id, role="owner"))
    apply_template(db, p, body.template)
    for name, color in DEFAULT_TAGS:
        db.add(m.Tag(project_id=p.id, name=name, color=color))
    log(db, p.id, user, "project.created", name=p.name)
    db.commit()
    return project_out(p, "owner")


@router.get("/projects/{project_id}")
def get_board(project_id: int, include_closed: bool = False,
              user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    pm = require_role(db, project_id, user)
    p = db.get(m.Project, project_id)
    members = db.scalars(
        select(m.ProjectMember).options(selectinload(m.ProjectMember.user))
        .where(m.ProjectMember.project_id == project_id).order_by(m.ProjectMember.joined_at)
    ).all()
    q = (select(m.Task).options(selectinload(m.Task.tags), selectinload(m.Task.watchers))
         .where(m.Task.project_id == project_id))
    if not include_closed:
        q = q.where(m.Task.status != "archived")
    tasks = db.scalars(q.order_by(m.Task.position)).all()
    sections = db.scalars(
        select(m.Section).options(selectinload(m.Section.automations))
        .where(m.Section.project_id == project_id).order_by(m.Section.position)
    ).all()
    return {
        "project": project_out(p, pm.role),
        "members": [member_out(x) for x in members],
        "sections": [section_out(s) for s in sections],
        "tags": [tag_out(t) for t in sorted(p.tags, key=lambda t: t.name.lower())],
        "tasks": task_summaries(db, list(tasks)),
        "online_user_ids": [uid for uid in hub.online_user_ids() if any(x.user_id == uid for x in members)],
    }


@router.patch("/projects/{project_id}")
def update_project(project_id: int, body: ProjectPatch,
                   user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    pm = require_role(db, project_id, user, "admin")
    p = db.get(m.Project, project_id)
    changes = body.model_dump(exclude_unset=True)
    for k, v in changes.items():
        setattr(p, k, v.strip() if isinstance(v, str) and k == "name" else v)
    if "archived" in changes:
        log(db, p.id, user, "project.archived" if p.archived else "project.restored")
    else:
        log(db, p.id, user, "project.updated", fields=list(changes))
    db.commit()
    broadcast(db, p.id, "project.updated", {"project": project_out(p)}, user.id)
    return project_out(p, pm.role)


@router.delete("/projects/{project_id}")
def delete_project(project_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "owner")
    p = db.get(m.Project, project_id)
    audience = [x.user_id for x in p.members]
    stored = list(db.scalars(
        select(m.Attachment.stored_name).join(m.Task, m.Task.id == m.Attachment.task_id)
        .where(m.Task.project_id == project_id)
    ))
    db.delete(p)
    db.commit()
    for name in stored:
        (UPLOAD_DIR / name).unlink(missing_ok=True)
    hub.publish(audience, {"type": "project.deleted", "project_id": project_id, "actor_id": user.id, "data": {}})
    return {"ok": True}


# ---------------------------------------------------------------- members

@router.post("/projects/{project_id}/members")
def add_member(project_id: int, body: MemberIn, request: Request, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "admin")
    if body.role not in ROLES or body.role == "owner":
        raise HTTPException(422, "Invalid role")
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(422, "Enter a valid email address")
    invitee, created = get_or_create_user(db, email)
    if membership(db, project_id, invitee.id):
        raise HTTPException(409, "Already a member")
    pm = m.ProjectMember(project_id=project_id, user_id=invitee.id, role=body.role)
    db.add(pm)
    p = db.get(m.Project, project_id)
    log(db, project_id, user, "member.added", member=invitee.name, role=body.role)
    notify(db, [invitee.id], user, "project.invited", f"{user.name} added you to “{p.name}”", project_id)
    db.commit()
    base = config.BASE_URL or str(request.base_url).rstrip("/")
    mailer.send_email(
        email, f"{user.name} invited you to “{p.name}” on tek-plane",
        f"{user.name} added you to the project “{p.name}” on tek-plane.\n\n"
        f"Open {base}/login and sign in with {email}" + (" (Google or a one-time email code)." if created else "."),
    )
    db.refresh(pm)
    broadcast(db, project_id, "members.changed", {}, user.id)
    return member_out(pm)


@router.patch("/projects/{project_id}/members/{member_user_id}")
def update_member(project_id: int, member_user_id: int, body: MemberPatch,
                  user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    actor = require_role(db, project_id, user, "admin")
    if body.role not in ROLES:
        raise HTTPException(422, "Invalid role")
    pm = membership(db, project_id, member_user_id)
    if not pm:
        raise HTTPException(404, "Member not found")
    if (pm.role == "owner" or body.role == "owner") and actor.role != "owner":
        raise HTTPException(403, "Only the owner can transfer ownership")
    if body.role == "owner":
        actor.role = "admin"
        db.get(m.Project, project_id).owner_id = member_user_id
    elif pm.role == "owner":
        raise HTTPException(400, "Transfer ownership to someone else first")
    pm.role = body.role
    log(db, project_id, user, "member.role", member=pm.user.name, role=body.role)
    db.commit()
    broadcast(db, project_id, "members.changed", {}, user.id)
    return member_out(pm)


@router.delete("/projects/{project_id}/members/{member_user_id}")
def remove_member(project_id: int, member_user_id: int,
                  user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    if member_user_id != user.id:
        require_role(db, project_id, user, "admin")
    pm = membership(db, project_id, member_user_id)
    if not pm:
        raise HTTPException(404, "Member not found")
    if pm.role == "owner":
        raise HTTPException(400, "The owner can't leave. Transfer ownership first.")
    name = pm.user.name
    audience = [member_user_id]
    db.delete(pm)
    for t in db.scalars(select(m.Task).where(m.Task.project_id == project_id, m.Task.assignee_id == member_user_id)):
        t.assignee_id = None
    log(db, project_id, user, "member.removed", member=name)
    db.commit()
    broadcast(db, project_id, "members.changed", {}, user.id)
    hub.publish(audience, {"type": "project.deleted", "project_id": project_id, "actor_id": user.id, "data": {}})
    return {"ok": True}


# ---------------------------------------------------------------- activity & stats

@router.get("/projects/{project_id}/activity")
def project_activity(project_id: int, limit: int = 50, before: int | None = None,
                     user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user)
    q = select(m.Activity).where(m.Activity.project_id == project_id)
    if before:
        q = q.where(m.Activity.id < before)
    rows = db.scalars(q.order_by(m.Activity.id.desc()).limit(min(limit, 200)))
    return [activity_out(a) for a in rows]


@router.get("/projects/{project_id}/stats")
def project_stats(project_id: int, days: int = 30,
                  user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user)
    days = max(7, min(days, 365))
    tasks = db.scalars(select(m.Task).where(m.Task.project_id == project_id)).all()
    sections = db.scalars(select(m.Section).where(m.Section.project_id == project_id)
                          .order_by(m.Section.position)).all()
    now = datetime.utcnow()
    start = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)

    def day_key(dt):
        return dt.strftime("%Y-%m-%d")

    series = {day_key(start + timedelta(days=i)): {"created": 0, "completed": 0} for i in range(days)}
    for t in tasks:
        if t.created_at >= start and day_key(t.created_at) in series:
            series[day_key(t.created_at)]["created"] += 1
        if t.completed_at and t.completed_at >= start and day_key(t.completed_at) in series:
            series[day_key(t.completed_at)]["completed"] += 1

    open_tasks = [t for t in tasks if t.status == "open"]
    by_section = [{"id": s.id, "name": s.name, "color": s.color,
                   "count": sum(1 for t in open_tasks if t.section_id == s.id)} for s in sections]
    by_assignee: dict = {}
    for t in tasks:
        if t.status == "archived":
            continue
        row = by_assignee.setdefault(t.assignee_id, {"user_id": t.assignee_id, "open": 0, "completed": 0})
        row["open" if t.status == "open" else "completed"] += 1
    by_priority: dict = {}
    for t in open_tasks:
        by_priority[t.priority] = by_priority.get(t.priority, 0) + 1

    time_by_user = dict(db.execute(
        select(m.TimeEntry.user_id, func.sum(m.TimeEntry.duration_seconds))
        .join(m.Task, m.Task.id == m.TimeEntry.task_id)
        .where(m.Task.project_id == project_id).group_by(m.TimeEntry.user_id)
    ).all())
    completed = [t for t in tasks if t.completed_at]
    lead_times = [(t.completed_at - t.created_at).total_seconds() / 86400 for t in completed]
    return {
        "totals": {
            "open": len(open_tasks),
            "completed": sum(1 for t in tasks if t.status == "completed"),
            "archived": sum(1 for t in tasks if t.status == "archived"),
            "overdue": sum(1 for t in open_tasks if t.due_date and t.due_date < now),
            "unassigned": sum(1 for t in open_tasks if not t.assignee_id),
            "avg_lead_days": round(sum(lead_times) / len(lead_times), 1) if lead_times else None,
            "tracked_seconds": int(sum(time_by_user.values()) or 0),
        },
        "series": [{"date": k, **v} for k, v in series.items()],
        "by_section": by_section,
        "by_assignee": list(by_assignee.values()),
        "by_priority": by_priority,
        "time_by_user": [{"user_id": k, "seconds": int(v or 0)} for k, v in time_by_user.items()],
    }
