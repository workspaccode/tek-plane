from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session, selectinload

from .. import models as m
from ..db import get_db
from ..security import current_user
from ..serializers import activity_out, iso, notification_out, project_out, task_summaries, user_out
from ..services import get_or_404, membership, next_position

router = APIRouter(prefix="/api", tags=["personal"])


def _my_project_ids(db: Session, user: m.User) -> list[int]:
    return list(db.scalars(
        select(m.ProjectMember.project_id).join(m.Project, m.Project.id == m.ProjectMember.project_id)
        .where(m.ProjectMember.user_id == user.id, m.Project.archived.is_(False))
    ))


def _with_context(db: Session, tasks: list[m.Task]) -> list[dict]:
    out = task_summaries(db, tasks)
    projects = {p.id: p for p in db.scalars(select(m.Project).where(m.Project.id.in_({t.project_id for t in tasks})))}
    sections = {s.id: s for s in db.scalars(select(m.Section).where(m.Section.id.in_({t.section_id for t in tasks})))}
    tags = {tg.id: tg for t in tasks for tg in t.tags}
    for row in out:
        p, s = projects.get(row["project_id"]), sections.get(row["section_id"])
        row["project"] = {"id": p.id, "name": p.name, "color": p.color} if p else None
        row["section"] = {"id": s.id, "name": s.name, "color": s.color} if s else None
        row["tags"] = [{"id": i, "name": tags[i].name, "color": tags[i].color} for i in row["tag_ids"] if i in tags]
    return out


# ---------------------------------------------------------------- my tasks & dashboard

@router.get("/me/tasks")
def my_tasks(scope: str = "assigned", include_completed: bool = False,
             user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    pids = _my_project_ids(db, user)
    q = select(m.Task).options(selectinload(m.Task.tags), selectinload(m.Task.watchers)).where(
        m.Task.project_id.in_(pids))
    if scope == "watching":
        q = q.join(m.TaskWatcher, m.TaskWatcher.task_id == m.Task.id).where(m.TaskWatcher.user_id == user.id)
    elif scope == "created":
        q = q.where(m.Task.creator_id == user.id)
    else:
        q = q.where(m.Task.assignee_id == user.id)
    q = q.where(m.Task.status.in_(("open", "completed")) if include_completed else m.Task.status == "open")
    tasks = db.scalars(q.order_by(m.Task.due_date.is_(None), m.Task.due_date, m.Task.id)).unique().all()
    return _with_context(db, list(tasks))


@router.get("/dashboard")
def dashboard(user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    pids = _my_project_ids(db, user)
    now = datetime.utcnow()
    today_end = now.replace(hour=23, minute=59, second=59)
    week_start = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    mine = db.scalars(select(m.Task).where(m.Task.project_id.in_(pids), m.Task.assignee_id == user.id,
                                           m.Task.status == "open")).all()
    completed_week = db.scalar(select(func.count(m.Task.id)).where(
        m.Task.project_id.in_(pids), m.Task.assignee_id == user.id, m.Task.completed_at >= week_start)) or 0
    tracked_week = db.scalar(select(func.sum(m.TimeEntry.duration_seconds)).where(
        m.TimeEntry.user_id == user.id, m.TimeEntry.started_at >= week_start)) or 0
    activity = db.scalars(select(m.Activity).where(m.Activity.project_id.in_(pids))
                          .order_by(m.Activity.id.desc()).limit(30)).all()
    projects = {p.id: p for p in db.scalars(select(m.Project).where(m.Project.id.in_(pids)))}
    upcoming = sorted([t for t in mine if t.due_date], key=lambda t: t.due_date)[:8]
    # 14-day completion trend for the user
    start = (now - timedelta(days=13)).replace(hour=0, minute=0, second=0, microsecond=0)
    done = db.scalars(select(m.Task.completed_at).where(
        m.Task.project_id.in_(pids), m.Task.assignee_id == user.id, m.Task.completed_at >= start)).all()
    trend = {(start + timedelta(days=i)).strftime("%Y-%m-%d"): 0 for i in range(14)}
    for d in done:
        k = d.strftime("%Y-%m-%d")
        if k in trend:
            trend[k] += 1
    return {
        "user": user_out(user),
        "counts": {
            "open": len(mine),
            "overdue": sum(1 for t in mine if t.due_date and t.due_date < now),
            "due_today": sum(1 for t in mine if t.due_date and now <= t.due_date <= today_end),
            "completed_week": completed_week,
            "tracked_week_seconds": int(tracked_week),
            "projects": len(pids),
        },
        "upcoming": _with_context(db, upcoming),
        "trend": [{"date": k, "completed": v} for k, v in trend.items()],
        "activity": [{**activity_out(a), "project": {"id": a.project_id, "name": projects[a.project_id].name,
                                                     "color": projects[a.project_id].color}}
                     for a in activity if a.project_id in projects],
    }


# ---------------------------------------------------------------- agenda

class AgendaSectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    color: str = "#8792a2"


class AgendaSectionPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    color: str | None = None


class PinIn(BaseModel):
    task_id: int
    section_id: int | None = None


class PinMove(BaseModel):
    section_id: int
    index: int | None = None


class ReorderIn(BaseModel):
    ids: list[int]


def _agenda_section(db: Session, sid: int, user: m.User) -> m.AgendaSection:
    s = get_or_404(db, m.AgendaSection, sid, "Agenda section")
    if s.user_id != user.id:
        raise HTTPException(404, "Agenda section not found")
    return s


@router.get("/agenda")
def agenda(user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    sections = db.scalars(select(m.AgendaSection).where(m.AgendaSection.user_id == user.id)
                          .order_by(m.AgendaSection.position)).all()
    pids = set(_my_project_ids(db, user))
    pins = [p for p in db.scalars(select(m.AgendaPin).where(m.AgendaPin.user_id == user.id)
                                  .order_by(m.AgendaPin.position)) if p.task.project_id in pids
            and p.task.status != "archived"]
    tasks = {t["id"]: t for t in _with_context(db, [p.task for p in pins])}
    return {
        "sections": [{"id": s.id, "name": s.name, "color": s.color, "position": s.position} for s in sections],
        "pins": [{"id": p.id, "section_id": p.section_id, "position": p.position, "task": tasks[p.task_id]}
                 for p in pins],
    }


@router.post("/agenda/sections")
def create_agenda_section(body: AgendaSectionIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    s = m.AgendaSection(user_id=user.id, name=body.name, color=body.color,
                        position=next_position(db, m.AgendaSection.position, m.AgendaSection.user_id == user.id))
    db.add(s)
    db.commit()
    return {"id": s.id, "name": s.name, "color": s.color, "position": s.position}


@router.patch("/agenda/sections/{sid}")
def update_agenda_section(sid: int, body: AgendaSectionPatch, user: m.User = Depends(current_user),
                          db: Session = Depends(get_db)):
    s = _agenda_section(db, sid, user)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(s, k, v)
    db.commit()
    return {"id": s.id, "name": s.name, "color": s.color, "position": s.position}


@router.delete("/agenda/sections/{sid}")
def delete_agenda_section(sid: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    s = _agenda_section(db, sid, user)
    db.delete(s)
    db.commit()
    return {"ok": True}


@router.post("/agenda/sections/reorder")
def reorder_agenda(body: ReorderIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    for i, sid in enumerate(body.ids):
        _agenda_section(db, sid, user).position = float(i * 1024)
    db.commit()
    return {"ok": True}


def _place_pin(db: Session, pin: m.AgendaPin, section_id: int, index: int | None):
    siblings = list(db.scalars(select(m.AgendaPin).where(
        m.AgendaPin.section_id == section_id, m.AgendaPin.id != pin.id).order_by(m.AgendaPin.position)))
    if index is None or index > len(siblings):
        index = len(siblings)
    siblings.insert(max(index, 0), pin)
    pin.section_id = section_id
    for i, p in enumerate(siblings):
        p.position = float(i * 1024)


@router.post("/agenda/pins")
def pin_task(body: PinIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    task = get_or_404(db, m.Task, body.task_id, "Task")
    if not membership(db, task.project_id, user.id):
        raise HTTPException(404, "Task not found")
    if body.section_id:
        section = _agenda_section(db, body.section_id, user)
    else:
        section = db.scalar(select(m.AgendaSection).where(m.AgendaSection.user_id == user.id)
                            .order_by(m.AgendaSection.position))
        if not section:
            section = m.AgendaSection(user_id=user.id, name="Today", color="#ef5350", position=0)
            db.add(section)
            db.flush()
    pin = db.scalar(select(m.AgendaPin).where(m.AgendaPin.user_id == user.id, m.AgendaPin.task_id == task.id))
    if not pin:
        pin = m.AgendaPin(user_id=user.id, task_id=task.id, section_id=section.id)
        db.add(pin)
        db.flush()
    _place_pin(db, pin, section.id, None)
    db.commit()
    return {"id": pin.id, "section_id": pin.section_id}


@router.post("/agenda/pins/{pin_id}/move")
def move_pin(pin_id: int, body: PinMove, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    pin = get_or_404(db, m.AgendaPin, pin_id, "Pin")
    if pin.user_id != user.id:
        raise HTTPException(404, "Pin not found")
    _agenda_section(db, body.section_id, user)
    _place_pin(db, pin, body.section_id, body.index)
    db.commit()
    return {"ok": True}


@router.delete("/agenda/pins/{pin_id}")
def unpin(pin_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    pin = get_or_404(db, m.AgendaPin, pin_id, "Pin")
    if pin.user_id != user.id:
        raise HTTPException(404, "Pin not found")
    db.delete(pin)
    db.commit()
    return {"ok": True}


@router.get("/agenda/pinned-task-ids")
def pinned_ids(user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    return list(db.scalars(select(m.AgendaPin.task_id).where(m.AgendaPin.user_id == user.id)))


# ---------------------------------------------------------------- notifications

class ReadIn(BaseModel):
    ids: list[int] | None = None
    all: bool = False


@router.get("/notifications")
def notifications(limit: int = 50, unread_only: bool = False,
                  user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    q = select(m.Notification).where(m.Notification.user_id == user.id)
    if unread_only:
        q = q.where(m.Notification.read.is_(False))
    rows = db.scalars(q.order_by(m.Notification.id.desc()).limit(min(limit, 200))).all()
    unread = db.scalar(select(func.count(m.Notification.id)).where(
        m.Notification.user_id == user.id, m.Notification.read.is_(False))) or 0
    return {"unread": unread, "items": [notification_out(n) for n in rows]}


@router.post("/notifications/read")
def mark_read(body: ReadIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    q = update(m.Notification).where(m.Notification.user_id == user.id)
    if not body.all:
        q = q.where(m.Notification.id.in_(body.ids or []))
    db.execute(q.values(read=True))
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- search

@router.get("/search")
def search(q: str = "", user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    q = q.strip()
    if not q:
        return {"tasks": [], "projects": []}
    pids = _my_project_ids(db, user)
    like = f"%{q.lower()}%"
    conds = [func.lower(m.Task.title).like(like), func.lower(m.Task.description).like(like)]
    if q.lstrip("#").isdigit():
        conds.append(m.Task.number == int(q.lstrip("#")))
    tasks = db.scalars(select(m.Task).options(selectinload(m.Task.tags), selectinload(m.Task.watchers))
                       .where(m.Task.project_id.in_(pids), or_(*conds))
                       .order_by(m.Task.status, m.Task.updated_at.desc()).limit(30)).all()
    projects = db.scalars(select(m.Project).where(m.Project.id.in_(pids), func.lower(m.Project.name).like(like))
                          .limit(10)).all()
    return {"tasks": _with_context(db, list(tasks)), "projects": [project_out(p) for p in projects]}


# ---------------------------------------------------------------- time report

@router.get("/reports/time")
def time_report(days: int = 7, project_id: int | None = None,
                user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    pids = _my_project_ids(db, user)
    if project_id:
        if project_id not in pids:
            raise HTTPException(404, "Project not found")
        pids = [project_id]
    start = (datetime.utcnow() - timedelta(days=max(1, min(days, 365)) - 1)).replace(
        hour=0, minute=0, second=0, microsecond=0)
    rows = db.execute(
        select(m.TimeEntry, m.Task).join(m.Task, m.Task.id == m.TimeEntry.task_id)
        .where(m.Task.project_id.in_(pids), m.TimeEntry.started_at >= start)
        .order_by(m.TimeEntry.started_at.desc())
    ).all()
    projects = {p.id: p for p in db.scalars(select(m.Project).where(m.Project.id.in_(pids)))}
    users = {u.id: u for u in db.scalars(select(m.User).where(m.User.id.in_({e.user_id for e, _ in rows})))}
    return [{
        "id": e.id, "started_at": iso(e.started_at), "ended_at": iso(e.ended_at),
        "duration_seconds": e.duration_seconds if e.ended_at else int((datetime.utcnow() - e.started_at).total_seconds()),
        "running": e.ended_at is None, "note": e.note, "user": user_out(users.get(e.user_id)),
        "task": {"id": t.id, "number": t.number, "title": t.title},
        "project": {"id": t.project_id, "name": projects[t.project_id].name, "color": projects[t.project_id].color},
    } for e, t in rows]
