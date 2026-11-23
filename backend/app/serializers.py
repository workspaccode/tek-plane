from datetime import datetime

from sqlalchemy import Integer, cast, func, select
from sqlalchemy.orm import Session

from . import models as m


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat() + "Z" if dt else None


def user_out(u: m.User | None) -> dict | None:
    if not u:
        return None
    return {"id": u.id, "name": u.name, "email": u.email, "avatar_color": u.avatar_color, "title": u.title}


def project_out(p: m.Project, role: str | None = None) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "description": p.description,
        "color": p.color,
        "icon": p.icon,
        "owner_id": p.owner_id,
        "archived": p.archived,
        "created_at": iso(p.created_at),
        "updated_at": iso(p.updated_at),
        "role": role,
    }


def automation_out(a: m.Automation) -> dict:
    return {"id": a.id, "section_id": a.section_id, "type": a.type, "config": a.config or {}, "active": a.active}


def section_out(s: m.Section) -> dict:
    return {
        "id": s.id,
        "project_id": s.project_id,
        "name": s.name,
        "color": s.color,
        "icon": s.icon,
        "position": s.position,
        "wip_limit": s.wip_limit,
        "automations": [automation_out(a) for a in s.automations],
    }


def tag_out(t: m.Tag) -> dict:
    return {"id": t.id, "project_id": t.project_id, "name": t.name, "color": t.color}


def member_out(pm: m.ProjectMember) -> dict:
    return {**user_out(pm.user), "role": pm.role, "joined_at": iso(pm.joined_at)}


def _task_counts(db: Session, task_ids: list[int]) -> dict[int, dict]:
    counts: dict[int, dict] = {
        tid: {"checklist_total": 0, "checklist_done": 0, "comments": 0, "attachments": 0,
              "time_seconds": 0, "relations": 0}
        for tid in task_ids
    }
    if not task_ids:
        return counts
    rows = db.execute(
        select(m.Checklist.task_id, func.count(m.ChecklistItem.id),
               func.sum(cast(m.ChecklistItem.done, Integer)))
        .join(m.ChecklistItem, m.ChecklistItem.checklist_id == m.Checklist.id)
        .where(m.Checklist.task_id.in_(task_ids))
        .group_by(m.Checklist.task_id)
    )
    for tid, total, done in rows:
        counts[tid]["checklist_total"] = total or 0
        counts[tid]["checklist_done"] = int(done or 0)
    for model, key in ((m.Comment, "comments"), (m.Attachment, "attachments")):
        for tid, n in db.execute(
            select(model.task_id, func.count(model.id)).where(model.task_id.in_(task_ids)).group_by(model.task_id)
        ):
            counts[tid][key] = n
    for tid, secs in db.execute(
        select(m.TimeEntry.task_id, func.sum(m.TimeEntry.duration_seconds))
        .where(m.TimeEntry.task_id.in_(task_ids))
        .group_by(m.TimeEntry.task_id)
    ):
        counts[tid]["time_seconds"] = int(secs or 0)
    for col in (m.TaskRelation.task_id, m.TaskRelation.related_task_id):
        for tid, n in db.execute(
            select(col, func.count(m.TaskRelation.id)).where(col.in_(task_ids)).group_by(col)
        ):
            counts[tid]["relations"] += n
    return counts


def task_summary(t: m.Task, counts: dict | None = None) -> dict:
    out = {
        "id": t.id,
        "project_id": t.project_id,
        "section_id": t.section_id,
        "number": t.number,
        "title": t.title,
        "description": t.description,
        "assignee_id": t.assignee_id,
        "creator_id": t.creator_id,
        "status": t.status,
        "priority": t.priority,
        "position": t.position,
        "start_date": iso(t.start_date),
        "due_date": iso(t.due_date),
        "estimate_minutes": t.estimate_minutes,
        "recurrence": t.recurrence,
        "completed_at": iso(t.completed_at),
        "created_at": iso(t.created_at),
        "updated_at": iso(t.updated_at),
        "tag_ids": [tag.id for tag in t.tags],
        "watcher_ids": [u.id for u in t.watchers],
    }
    out.update(counts or {})
    return out


def task_summaries(db: Session, tasks: list[m.Task]) -> list[dict]:
    counts = _task_counts(db, [t.id for t in tasks])
    return [task_summary(t, counts[t.id]) for t in tasks]


def checklist_out(c: m.Checklist) -> dict:
    return {
        "id": c.id,
        "task_id": c.task_id,
        "name": c.name,
        "position": c.position,
        "items": [
            {"id": i.id, "checklist_id": i.checklist_id, "text": i.text, "done": i.done, "position": i.position}
            for i in c.items
        ],
    }


def comment_out(c: m.Comment) -> dict:
    return {
        "id": c.id,
        "task_id": c.task_id,
        "user_id": c.user_id,
        "user": user_out(c.user),
        "body": c.body,
        "created_at": iso(c.created_at),
        "updated_at": iso(c.updated_at),
    }


def attachment_out(a: m.Attachment) -> dict:
    return {
        "id": a.id,
        "task_id": a.task_id,
        "user_id": a.user_id,
        "filename": a.filename,
        "size": a.size,
        "mime": a.mime,
        "is_image": a.mime.startswith("image/"),
        "created_at": iso(a.created_at),
        "url": f"/api/attachments/{a.id}/download",
    }


def time_entry_out(e: m.TimeEntry) -> dict:
    return {
        "id": e.id,
        "task_id": e.task_id,
        "user_id": e.user_id,
        "user": user_out(e.user),
        "started_at": iso(e.started_at),
        "ended_at": iso(e.ended_at),
        "duration_seconds": e.duration_seconds,
        "running": e.ended_at is None,
        "note": e.note,
    }


def activity_out(a: m.Activity) -> dict:
    return {
        "id": a.id,
        "project_id": a.project_id,
        "task_id": a.task_id,
        "user": user_out(a.user),
        "action": a.action,
        "data": a.data or {},
        "created_at": iso(a.created_at),
    }


def notification_out(n: m.Notification) -> dict:
    return {
        "id": n.id,
        "type": n.type,
        "message": n.message,
        "project_id": n.project_id,
        "task_id": n.task_id,
        "actor": user_out(n.actor),
        "read": n.read,
        "created_at": iso(n.created_at),
    }
