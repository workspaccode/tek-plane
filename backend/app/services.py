import calendar
import random
import re
from datetime import datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import models as m
from .realtime import hub
from .serializers import notification_out, task_summaries

ROLE_RANK = {"viewer": 0, "member": 1, "admin": 2, "owner": 3}
ROLES = tuple(ROLE_RANK)


# ---------------------------------------------------------------- permissions

def membership(db: Session, project_id: int, user_id: int) -> m.ProjectMember | None:
    return db.scalar(
        select(m.ProjectMember).where(
            m.ProjectMember.project_id == project_id, m.ProjectMember.user_id == user_id
        )
    )


def require_role(db: Session, project_id: int, user: m.User, minimum: str = "viewer") -> m.ProjectMember:
    pm = membership(db, project_id, user.id)
    if not pm:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
    if ROLE_RANK[pm.role] < ROLE_RANK[minimum]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires {minimum} role")
    return pm


def get_or_404(db: Session, model, obj_id: int, label: str = "Resource"):
    obj = db.get(model, obj_id)
    if not obj:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label} not found")
    return obj


def task_for(db: Session, task_id: int, user: m.User, minimum: str = "viewer") -> m.Task:
    task = get_or_404(db, m.Task, task_id, "Task")
    require_role(db, task.project_id, user, minimum)
    return task


def member_ids(db: Session, project_id: int) -> list[int]:
    return list(db.scalars(select(m.ProjectMember.user_id).where(m.ProjectMember.project_id == project_id)))


# ---------------------------------------------------------------- realtime

def broadcast(db: Session, project_id: int, event: str, data: dict | None = None, actor_id: int | None = None):
    hub.publish(
        member_ids(db, project_id),
        {"type": event, "project_id": project_id, "actor_id": actor_id, "data": data or {}},
    )


def broadcast_task(db: Session, task: m.Task, actor_id: int | None, event: str = "task.updated"):
    broadcast(db, task.project_id, event, {"task": task_summaries(db, [task])[0]}, actor_id)


# ---------------------------------------------------------------- activity & notifications

def log(db: Session, project_id: int, user: m.User | None, action: str, task: m.Task | None = None, **data):
    db.add(m.Activity(
        project_id=project_id,
        task_id=task.id if task else None,
        user_id=user.id if user else None,
        action=action,
        data={**({"task_title": task.title, "task_number": task.number} if task else {}), **data},
    ))


def notify(db: Session, user_ids, actor: m.User | None, ntype: str, message: str,
           project_id: int | None = None, task_id: int | None = None):
    created = []
    for uid in set(user_ids):
        if actor and uid == actor.id:
            continue
        n = m.Notification(user_id=uid, actor_id=actor.id if actor else None, type=ntype,
                           message=message, project_id=project_id, task_id=task_id)
        db.add(n)
        created.append(n)
    db.flush()
    for n in created:
        db.refresh(n)
        hub.publish([n.user_id], {"type": "notification", "data": notification_out(n)})


def task_audience(task: m.Task) -> set[int]:
    ids = {u.id for u in task.watchers}
    if task.assignee_id:
        ids.add(task.assignee_id)
    if task.creator_id:
        ids.add(task.creator_id)
    return ids


MENTION_RE = re.compile(r"@\[([^\]]+)\]\((\d+)\)")


def mentioned_user_ids(text: str) -> set[int]:
    return {int(uid) for _, uid in MENTION_RE.findall(text or "")}


# ---------------------------------------------------------------- ordering

def next_position(db: Session, column, where) -> float:
    current = db.scalar(select(func.max(column)).where(where))
    return (current or 0) + 1024


def place_task(db: Session, task: m.Task, section_id: int, index: int | None):
    """Insert task into section at index (None = end) and renumber open tasks there."""
    siblings = list(db.scalars(
        select(m.Task)
        .where(m.Task.section_id == section_id, m.Task.status == "open", m.Task.id != task.id)
        .order_by(m.Task.position)
    ))
    if index is None or index > len(siblings):
        index = len(siblings)
    siblings.insert(max(index, 0), task)
    task.section_id = section_id
    for i, t in enumerate(siblings):
        t.position = float(i * 1024)


# ---------------------------------------------------------------- recurrence

def shift_date(dt: datetime, recurrence: str) -> datetime:
    if recurrence == "daily":
        return dt + timedelta(days=1)
    if recurrence == "weekly":
        return dt + timedelta(weeks=1)
    if recurrence == "monthly":
        month = dt.month % 12 + 1
        year = dt.year + (dt.month == 12)
        day = min(dt.day, calendar.monthrange(year, month)[1])
        return dt.replace(year=year, month=month, day=day)
    return dt


def spawn_recurrence(db: Session, task: m.Task, user: m.User) -> m.Task | None:
    if not task.recurrence or not task.due_date:
        return None
    project = db.get(m.Project, task.project_id)
    project.task_counter += 1
    nxt = m.Task(
        project_id=task.project_id,
        section_id=task.section_id,
        number=project.task_counter,
        title=task.title,
        description=task.description,
        assignee_id=task.assignee_id,
        creator_id=user.id,
        priority=task.priority,
        due_date=shift_date(task.due_date, task.recurrence),
        start_date=shift_date(task.start_date, task.recurrence) if task.start_date else None,
        estimate_minutes=task.estimate_minutes,
        recurrence=task.recurrence,
        position=next_position(db, m.Task.position, m.Task.section_id == task.section_id),
    )
    nxt.tags = list(task.tags)
    nxt.watchers = list(task.watchers)
    for cl in task.checklists:
        new_cl = m.Checklist(name=cl.name, position=cl.position)
        new_cl.items = [m.ChecklistItem(text=i.text, position=i.position) for i in cl.items]
        nxt.checklists.append(new_cl)
    task.recurrence = None
    db.add(nxt)
    db.flush()
    log(db, task.project_id, user, "task.recurred", nxt, from_number=task.number)
    return nxt


def set_status(db: Session, task: m.Task, new_status: str, user: m.User):
    if task.status == new_status:
        return
    old = task.status
    task.status = new_status
    task.completed_at = m.utcnow() if new_status == "completed" else None
    log(db, task.project_id, user, f"task.{new_status}" if new_status != "open" else "task.reopened", task)
    if new_status == "completed":
        notify(db, task_audience(task), user, "task.completed",
               f"{user.name} completed “{task.title}”", task.project_id, task.id)
        spawn_recurrence(db, task, user)
    elif old != "open" and new_status == "open":
        place_task(db, task, task.section_id, None)


# ---------------------------------------------------------------- automations

AUTOMATION_TYPES = (
    "complete", "reopen", "assign", "add_tag", "set_due", "add_checklist", "add_watcher", "set_priority",
)


def run_automations(db: Session, task: m.Task, section: m.Section, user: m.User) -> list[str]:
    applied = []
    for a in section.automations:
        if not a.active:
            continue
        cfg = a.config or {}
        try:
            if a.type == "complete":
                set_status(db, task, "completed", user)
            elif a.type == "reopen":
                set_status(db, task, "open", user)
            elif a.type == "assign":
                uid = cfg.get("user_id")
                if uid and membership(db, task.project_id, uid):
                    task.assignee_id = uid
                elif cfg.get("unassign"):
                    task.assignee_id = None
            elif a.type == "add_tag":
                tag = db.get(m.Tag, cfg.get("tag_id"))
                if tag and tag.project_id == task.project_id and tag not in task.tags:
                    task.tags.append(tag)
            elif a.type == "set_due":
                days = int(cfg.get("days", 0))
                task.due_date = (datetime.utcnow() + timedelta(days=days)).replace(
                    hour=17, minute=0, second=0, microsecond=0)
            elif a.type == "add_checklist":
                cl = m.Checklist(name=cfg.get("name") or "Checklist",
                                 position=next_position(db, m.Checklist.position, m.Checklist.task_id == task.id))
                cl.items = [m.ChecklistItem(text=t, position=i * 1024) for i, t in enumerate(cfg.get("items", [])) if t]
                task.checklists.append(cl)
            elif a.type == "add_watcher":
                u = db.get(m.User, cfg.get("user_id"))
                if u and u not in task.watchers and membership(db, task.project_id, u.id):
                    task.watchers.append(u)
            elif a.type == "set_priority":
                if cfg.get("priority") in ("none", "low", "medium", "high", "urgent"):
                    task.priority = cfg["priority"]
            else:
                continue
            applied.append(a.type)
        except (TypeError, ValueError):
            continue
    if applied:
        log(db, task.project_id, user, "automation.ran", task, section=section.name, automations=applied)
    return applied


# ---------------------------------------------------------------- templates

TEMPLATES = {
    "kanban": [
        ("Open", "#8792a2", "inbox", []),
        ("In Progress", "#4f7cff", "play", []),
        ("Review", "#f5a623", "eye", []),
        ("Done", "#2fb67c", "check", [("complete", {})]),
    ],
    "scrum": [
        ("Backlog", "#8792a2", "inbox", []),
        ("Sprint", "#9b6bff", "flag", []),
        ("In Progress", "#4f7cff", "play", []),
        ("Testing", "#f5a623", "beaker", []),
        ("Done", "#2fb67c", "check", [("complete", {})]),
    ],
    "personal": [
        ("To Do", "#8792a2", "inbox", []),
        ("Doing", "#4f7cff", "play", []),
        ("Done", "#2fb67c", "check", [("complete", {})]),
    ],
    "marketing": [
        ("Ideas", "#9b6bff", "bulb", []),
        ("Planned", "#8792a2", "calendar", []),
        ("Writing", "#4f7cff", "pen", []),
        ("Approval", "#f5a623", "eye", []),
        ("Published", "#2fb67c", "check", [("complete", {})]),
    ],
    "blank": [("Open", "#8792a2", "inbox", [])],
}


def apply_template(db: Session, project: m.Project, template: str):
    for i, (name, color, icon, autos) in enumerate(TEMPLATES.get(template, TEMPLATES["kanban"])):
        s = m.Section(project_id=project.id, name=name, color=color, icon=icon, position=i * 1024)
        s.automations = [m.Automation(type=t, config=c) for t, c in autos]
        db.add(s)


DEFAULT_TAGS = [("Bug", "#ef5350"), ("Feature", "#4f7cff"), ("Improvement", "#2fb67c"), ("Research", "#9b6bff")]


def default_agenda(db: Session, user: m.User):
    for i, (name, color) in enumerate((("Today", "#ef5350"), ("This Week", "#f5a623"), ("Later", "#8792a2"))):
        db.add(m.AgendaSection(user_id=user.id, name=name, color=color, position=i * 1024))


AVATAR_COLORS = ["#4f7cff", "#9b6bff", "#2fb67c", "#f5a623", "#ef5350", "#00a3bf", "#e64a9e", "#6d7a8c"]


def get_or_create_user(db: Session, email: str, name: str | None = None) -> tuple[m.User, bool]:
    user = db.scalar(select(m.User).where(m.User.email == email))
    if user:
        return user, False
    user = m.User(email=email, name=(name or email.split("@")[0]).strip()[:120] or "New user",
                  avatar_color=random.choice(AVATAR_COLORS))
    db.add(user)
    db.flush()
    default_agenda(db, user)
    return user, True
