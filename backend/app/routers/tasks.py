import mimetypes
import secrets
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .. import models as m
from ..config import MAX_UPLOAD_BYTES, UPLOAD_DIR
from ..db import get_db
from ..security import current_user, current_user_or_query_token
from ..serializers import (
    activity_out,
    attachment_out,
    checklist_out,
    comment_out,
    task_summaries,
    time_entry_out,
    user_out,
)
from ..services import (
    broadcast,
    broadcast_task,
    get_or_404,
    log,
    membership,
    mentioned_user_ids,
    next_position,
    notify,
    place_task,
    require_role,
    run_automations,
    set_status,
    task_audience,
    task_for,
)

router = APIRouter(prefix="/api", tags=["tasks"])

PRIORITIES = ("none", "low", "medium", "high", "urgent")
RECURRENCES = (None, "daily", "weekly", "monthly")
RELATION_TYPES = ("blocks", "relates", "duplicates")


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    section_id: int
    description: str = ""
    assignee_id: int | None = None
    due_date: datetime | None = None
    start_date: datetime | None = None
    priority: str = "none"
    tag_ids: list[int] = []
    index: int | None = None  # None = bottom; 0 = top


class TaskPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    description: str | None = None
    assignee_id: int | None = None
    due_date: datetime | None = None
    start_date: datetime | None = None
    priority: str | None = None
    status: str | None = None
    estimate_minutes: int | None = None
    recurrence: str | None = None
    tag_ids: list[int] | None = None
    watcher_ids: list[int] | None = None


class MoveIn(BaseModel):
    section_id: int
    index: int | None = None
    project_id: int | None = None


class BulkIn(BaseModel):
    task_ids: list[int]
    action: str  # complete|reopen|archive|delete|assign|move|tag|priority|due
    value: int | str | None = None


class ChecklistIn(BaseModel):
    name: str = Field("Checklist", max_length=160)
    items: list[str] = []


class ChecklistPatch(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class ItemIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class ItemPatch(BaseModel):
    text: str | None = Field(None, min_length=1, max_length=500)
    done: bool | None = None
    index: int | None = None


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class TimeIn(BaseModel):
    minutes: int = Field(gt=0, le=24 * 60)
    note: str = ""
    date: datetime | None = None


class RelationIn(BaseModel):
    related_task_id: int
    type: str = "relates"


def _naive(dt: datetime | None) -> datetime | None:
    """Store everything as naive UTC."""
    if dt and dt.tzinfo:
        return (dt - (dt.utcoffset() or timedelta())).replace(tzinfo=None)
    return dt


def _validate_assignee(db: Session, project_id: int, uid: int | None):
    if uid is not None and not membership(db, project_id, uid):
        raise HTTPException(422, "Assignee must be a project member")


def _tags(db: Session, project_id: int, ids: list[int]) -> list[m.Tag]:
    tags = db.scalars(select(m.Tag).where(m.Tag.id.in_(ids), m.Tag.project_id == project_id)).all() if ids else []
    return list(tags)


def _summary(db: Session, task: m.Task) -> dict:
    return task_summaries(db, [task])[0]


# ---------------------------------------------------------------- task CRUD

@router.post("/projects/{project_id}/tasks")
def create_task(project_id: int, body: TaskIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "member")
    section = get_or_404(db, m.Section, body.section_id, "Section")
    if section.project_id != project_id:
        raise HTTPException(422, "Section belongs to another project")
    if body.priority not in PRIORITIES:
        raise HTTPException(422, "Invalid priority")
    _validate_assignee(db, project_id, body.assignee_id)
    project = db.get(m.Project, project_id)
    project.task_counter += 1
    task = m.Task(
        project_id=project_id, section_id=section.id, number=project.task_counter,
        title=body.title.strip(), description=body.description, assignee_id=body.assignee_id,
        creator_id=user.id, due_date=_naive(body.due_date), start_date=_naive(body.start_date),
        priority=body.priority,
    )
    task.tags = _tags(db, project_id, body.tag_ids)
    task.watchers = [user]
    db.add(task)
    db.flush()
    place_task(db, task, section.id, body.index)
    log(db, project_id, user, "task.created", task, section=section.name)
    if task.assignee_id and task.assignee_id != user.id:
        notify(db, [task.assignee_id], user, "task.assigned",
               f"{user.name} assigned you “{task.title}”", project_id, task.id)
    run_automations(db, task, section, user)
    db.commit()
    broadcast_task(db, task, user.id, "task.created")
    return _summary(db, task)


@router.get("/tasks/{task_id}")
def get_task(task_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    task = task_for(db, task_id, user)
    relations = db.scalars(select(m.TaskRelation).where(
        or_(m.TaskRelation.task_id == task.id, m.TaskRelation.related_task_id == task.id))).all()
    rel_out = []
    for r in relations:
        outgoing = r.task_id == task.id
        other = db.get(m.Task, r.related_task_id if outgoing else r.task_id)
        if not other or not membership(db, other.project_id, user.id):
            continue
        label = {"blocks": "blocks" if outgoing else "blocked by",
                 "duplicates": "duplicates" if outgoing else "duplicated by",
                 "relates": "relates to"}[r.type]
        rel_out.append({
            "id": r.id, "type": r.type, "label": label, "outgoing": outgoing,
            "task": {"id": other.id, "number": other.number, "title": other.title, "status": other.status,
                     "project_id": other.project_id, "project_name": other.project.name},
        })
    activity = db.scalars(select(m.Activity).where(m.Activity.task_id == task.id)
                          .order_by(m.Activity.id.desc()).limit(100)).all()
    return {
        **_summary(db, task),
        "project": {"id": task.project.id, "name": task.project.name, "color": task.project.color},
        "section": {"id": task.section.id, "name": task.section.name, "color": task.section.color},
        "assignee": user_out(task.assignee),
        "watchers": [user_out(u) for u in task.watchers],
        "checklists": [checklist_out(c) for c in task.checklists],
        "comments": [comment_out(c) for c in task.comments],
        "attachments": [attachment_out(a) for a in task.attachments],
        "time_entries": [time_entry_out(e) for e in reversed(task.time_entries)],
        "relations": rel_out,
        "activity": [activity_out(a) for a in activity],
    }


@router.patch("/tasks/{task_id}")
def update_task(task_id: int, body: TaskPatch, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    task = task_for(db, task_id, user, "member")
    changes = body.model_dump(exclude_unset=True)
    changed = []
    if "title" in changes and changes["title"].strip() != task.title:
        log(db, task.project_id, user, "task.renamed", task, old=task.title, new=changes["title"].strip())
        task.title = changes["title"].strip()
        changed.append("title")
    if "description" in changes and changes["description"] != task.description:
        task.description = changes["description"]
        log(db, task.project_id, user, "task.description", task)
        new_mentions = mentioned_user_ids(task.description)
        notify(db, [u for u in new_mentions if membership(db, task.project_id, u)], user, "mention",
               f"{user.name} mentioned you in “{task.title}”", task.project_id, task.id)
        changed.append("description")
    if "assignee_id" in changes and changes["assignee_id"] != task.assignee_id:
        _validate_assignee(db, task.project_id, changes["assignee_id"])
        task.assignee_id = changes["assignee_id"]
        new = db.get(m.User, task.assignee_id) if task.assignee_id else None
        log(db, task.project_id, user, "task.assigned", task, assignee=new.name if new else None)
        if new:
            notify(db, [new.id], user, "task.assigned", f"{user.name} assigned you “{task.title}”",
                   task.project_id, task.id)
            if new not in task.watchers:
                task.watchers.append(new)
        changed.append("assignee")
    for field in ("due_date", "start_date"):
        if field in changes:
            value = _naive(changes[field])
            if value != getattr(task, field):
                setattr(task, field, value)
                log(db, task.project_id, user, f"task.{field}", task, value=value.isoformat() if value else None)
                changed.append(field)
    if "priority" in changes and changes["priority"] != task.priority:
        if changes["priority"] not in PRIORITIES:
            raise HTTPException(422, "Invalid priority")
        task.priority = changes["priority"]
        log(db, task.project_id, user, "task.priority", task, value=task.priority)
    if "estimate_minutes" in changes:
        task.estimate_minutes = changes["estimate_minutes"]
    if "recurrence" in changes:
        if changes["recurrence"] not in RECURRENCES:
            raise HTTPException(422, "Invalid recurrence")
        task.recurrence = changes["recurrence"]
        log(db, task.project_id, user, "task.recurrence", task, value=task.recurrence)
    if "tag_ids" in changes:
        task.tags = _tags(db, task.project_id, changes["tag_ids"] or [])
        log(db, task.project_id, user, "task.tags", task, tags=[t.name for t in task.tags])
    if "watcher_ids" in changes:
        ids = [u for u in changes["watcher_ids"] or [] if membership(db, task.project_id, u)]
        task.watchers = list(db.scalars(select(m.User).where(m.User.id.in_(ids)))) if ids else []
    if "status" in changes:
        if changes["status"] not in ("open", "completed", "archived"):
            raise HTTPException(422, "Invalid status")
        set_status(db, task, changes["status"], user)
    if changed and {"due_date", "title", "description"} & set(changed):
        notify(db, task_audience(task) - {task.assignee_id} if "assignee" in changed else task_audience(task),
               user, "task.updated", f"{user.name} updated “{task.title}”", task.project_id, task.id)
    db.commit()
    broadcast_task(db, task, user.id)
    return _summary(db, task)


@router.post("/tasks/{task_id}/move")
def move_task(task_id: int, body: MoveIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    task = task_for(db, task_id, user, "member")
    section = get_or_404(db, m.Section, body.section_id, "Section")
    target_project = body.project_id or section.project_id
    if section.project_id != target_project:
        raise HTTPException(422, "Section belongs to another project")
    old_project, old_section = task.project_id, task.section_id
    if target_project != task.project_id:
        require_role(db, target_project, user, "member")
        project = db.get(m.Project, target_project)
        project.task_counter += 1
        task.number = project.task_counter
        task.project_id = target_project
        task.tags = []
        if task.assignee_id and not membership(db, target_project, task.assignee_id):
            task.assignee_id = None
        task.watchers = [u for u in task.watchers if membership(db, target_project, u.id)]
        log(db, old_project, user, "task.moved_out", task, to_project=project.name)
    place_task(db, task, section.id, body.index)
    if old_section != section.id:
        log(db, task.project_id, user, "task.moved", task, section=section.name)
        run_automations(db, task, section, user)
    db.commit()
    if old_project != task.project_id:
        broadcast(db, old_project, "task.deleted", {"task_id": task.id}, user.id)
        broadcast_task(db, task, user.id, "task.created")
    else:
        broadcast(db, task.project_id, "board.reordered",
                  {"section_ids": list({old_section, section.id})}, user.id)
    return _summary(db, task)


@router.post("/tasks/{task_id}/duplicate")
def duplicate_task(task_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    src = task_for(db, task_id, user, "member")
    project = db.get(m.Project, src.project_id)
    project.task_counter += 1
    copy = m.Task(
        project_id=src.project_id, section_id=src.section_id, number=project.task_counter,
        title=f"{src.title} (copy)", description=src.description, assignee_id=src.assignee_id,
        creator_id=user.id, priority=src.priority, due_date=src.due_date, start_date=src.start_date,
        estimate_minutes=src.estimate_minutes,
    )
    copy.tags = list(src.tags)
    copy.watchers = [user]
    for cl in src.checklists:
        new_cl = m.Checklist(name=cl.name, position=cl.position)
        new_cl.items = [m.ChecklistItem(text=i.text, position=i.position) for i in cl.items]
        copy.checklists.append(new_cl)
    db.add(copy)
    db.flush()
    siblings = sorted([t for t in db.scalars(select(m.Task).where(
        m.Task.section_id == src.section_id, m.Task.status == "open"))], key=lambda t: t.position)
    idx = next((i for i, t in enumerate(siblings) if t.id == src.id), len(siblings) - 1)
    place_task(db, copy, src.section_id, idx + 1)
    log(db, copy.project_id, user, "task.created", copy, duplicated_from=src.number)
    db.commit()
    broadcast_task(db, copy, user.id, "task.created")
    return _summary(db, copy)


@router.delete("/tasks/{task_id}")
def delete_task(task_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    task = task_for(db, task_id, user, "member")
    pm = membership(db, task.project_id, user.id)
    if pm.role == "member" and task.creator_id != user.id:
        raise HTTPException(403, "Only admins or the creator can delete this task. Archive it instead.")
    pid, title, number = task.project_id, task.title, task.number
    for a in task.attachments:
        (UPLOAD_DIR / a.stored_name).unlink(missing_ok=True)
    db.delete(task)
    db.flush()
    log(db, pid, user, "task.deleted", task_title=title, task_number=number)
    db.commit()
    broadcast(db, pid, "task.deleted", {"task_id": task_id}, user.id)
    return {"ok": True}


@router.post("/projects/{project_id}/tasks/bulk")
def bulk_update(project_id: int, body: BulkIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    pm = require_role(db, project_id, user, "member")
    tasks = db.scalars(select(m.Task).where(m.Task.id.in_(body.task_ids), m.Task.project_id == project_id)).all()
    for task in tasks:
        if body.action in ("complete", "reopen", "archive"):
            set_status(db, task, {"complete": "completed", "reopen": "open", "archive": "archived"}[body.action], user)
        elif body.action == "delete":
            if pm.role == "member" and task.creator_id != user.id:
                continue
            for a in task.attachments:
                (UPLOAD_DIR / a.stored_name).unlink(missing_ok=True)
            db.delete(task)
        elif body.action == "assign":
            uid = int(body.value) if body.value else None
            _validate_assignee(db, project_id, uid)
            task.assignee_id = uid
        elif body.action == "move":
            section = get_or_404(db, m.Section, int(body.value), "Section")
            if section.project_id == project_id and section.id != task.section_id:
                place_task(db, task, section.id, None)
                run_automations(db, task, section, user)
        elif body.action == "tag":
            tag = db.get(m.Tag, int(body.value))
            if tag and tag.project_id == project_id and tag not in task.tags:
                task.tags.append(tag)
        elif body.action == "priority" and body.value in PRIORITIES:
            task.priority = body.value
        elif body.action == "due":
            task.due_date = datetime.fromisoformat(str(body.value).replace("Z", "")) if body.value else None
    log(db, project_id, user, "task.bulk", operation=body.action, count=len(tasks))
    db.commit()
    broadcast(db, project_id, "board.changed", {}, user.id)
    return {"ok": True, "count": len(tasks)}


# ---------------------------------------------------------------- checklists

def _checklist(db: Session, checklist_id: int, user: m.User, minimum="member") -> m.Checklist:
    cl = get_or_404(db, m.Checklist, checklist_id, "Checklist")
    task_for(db, cl.task_id, user, minimum)
    return cl


def _after_change(db: Session, task: m.Task, user: m.User):
    db.commit()
    broadcast_task(db, task, user.id)


@router.post("/tasks/{task_id}/checklists")
def create_checklist(task_id: int, body: ChecklistIn, user: m.User = Depends(current_user),
                     db: Session = Depends(get_db)):
    task = task_for(db, task_id, user, "member")
    cl = m.Checklist(task_id=task.id, name=body.name or "Checklist",
                     position=next_position(db, m.Checklist.position, m.Checklist.task_id == task.id))
    cl.items = [m.ChecklistItem(text=t.strip(), position=i * 1024) for i, t in enumerate(body.items) if t.strip()]
    db.add(cl)
    log(db, task.project_id, user, "checklist.created", task, name=cl.name)
    db.flush()
    out = checklist_out(cl)
    _after_change(db, task, user)
    return out


@router.patch("/checklists/{checklist_id}")
def rename_checklist(checklist_id: int, body: ChecklistPatch, user: m.User = Depends(current_user),
                     db: Session = Depends(get_db)):
    cl = _checklist(db, checklist_id, user)
    cl.name = body.name
    out = checklist_out(cl)
    _after_change(db, cl.task, user)
    return out


@router.delete("/checklists/{checklist_id}")
def delete_checklist(checklist_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    cl = _checklist(db, checklist_id, user)
    task = cl.task
    db.delete(cl)
    _after_change(db, task, user)
    return {"ok": True}


@router.post("/checklists/{checklist_id}/items")
def add_item(checklist_id: int, body: ItemIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    cl = _checklist(db, checklist_id, user)
    item = m.ChecklistItem(checklist_id=cl.id, text=body.text.strip(),
                           position=next_position(db, m.ChecklistItem.position,
                                                  m.ChecklistItem.checklist_id == cl.id))
    db.add(item)
    db.flush()
    db.refresh(cl)
    out = checklist_out(cl)
    _after_change(db, cl.task, user)
    return out


@router.patch("/checklist-items/{item_id}")
def update_item(item_id: int, body: ItemPatch, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    item = get_or_404(db, m.ChecklistItem, item_id, "Item")
    cl = _checklist(db, item.checklist_id, user)
    if body.text is not None:
        item.text = body.text.strip()
    if body.done is not None and body.done != item.done:
        item.done = body.done
        log(db, cl.task.project_id, user, "checklist.checked" if item.done else "checklist.unchecked",
            cl.task, item=item.text)
    if body.index is not None:
        items = [i for i in cl.items if i.id != item.id]
        items.insert(max(0, min(body.index, len(items))), item)
        for i, it in enumerate(items):
            it.position = float(i * 1024)
    db.flush()
    db.refresh(cl)
    out = checklist_out(cl)
    _after_change(db, cl.task, user)
    return out


@router.delete("/checklist-items/{item_id}")
def delete_item(item_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    item = get_or_404(db, m.ChecklistItem, item_id, "Item")
    cl = _checklist(db, item.checklist_id, user)
    db.delete(item)
    db.flush()
    db.refresh(cl)
    out = checklist_out(cl)
    _after_change(db, cl.task, user)
    return out


# ---------------------------------------------------------------- comments

@router.post("/tasks/{task_id}/comments")
def add_comment(task_id: int, body: CommentIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    task = task_for(db, task_id, user, "member")
    c = m.Comment(task_id=task.id, user_id=user.id, body=body.body)
    db.add(c)
    if user not in task.watchers:
        task.watchers.append(user)
    log(db, task.project_id, user, "comment.added", task, excerpt=body.body[:140])
    mentions = {u for u in mentioned_user_ids(body.body) if membership(db, task.project_id, u)}
    notify(db, mentions, user, "mention", f"{user.name} mentioned you on “{task.title}”", task.project_id, task.id)
    notify(db, task_audience(task) - mentions, user, "comment",
           f"{user.name} commented on “{task.title}”", task.project_id, task.id)
    db.commit()
    db.refresh(c)
    out = comment_out(c)
    broadcast(db, task.project_id, "comment.added", {"task_id": task.id, "comment": out}, user.id)
    broadcast_task(db, task, user.id)
    return out


@router.patch("/comments/{comment_id}")
def edit_comment(comment_id: int, body: CommentIn, user: m.User = Depends(current_user),
                 db: Session = Depends(get_db)):
    c = get_or_404(db, m.Comment, comment_id, "Comment")
    task_for(db, c.task_id, user)
    if c.user_id != user.id:
        raise HTTPException(403, "You can only edit your own comments")
    c.body = body.body
    c.updated_at = m.utcnow()
    db.commit()
    out = comment_out(c)
    broadcast(db, c.task.project_id, "comment.updated", {"task_id": c.task_id, "comment": out}, user.id)
    return out


@router.delete("/comments/{comment_id}")
def delete_comment(comment_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    c = get_or_404(db, m.Comment, comment_id, "Comment")
    task = task_for(db, c.task_id, user)
    pm = membership(db, task.project_id, user.id)
    if c.user_id != user.id and pm.role not in ("admin", "owner"):
        raise HTTPException(403, "You can only delete your own comments")
    db.delete(c)
    db.commit()
    broadcast_task(db, task, user.id)
    return {"ok": True}


# ---------------------------------------------------------------- attachments

@router.post("/tasks/{task_id}/attachments")
async def upload_attachment(task_id: int, file: UploadFile = File(...), user: m.User = Depends(current_user),
                            db: Session = Depends(get_db)):
    task = task_for(db, task_id, user, "member")
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
    filename = Path(file.filename or "file").name[:255]
    stored = f"{secrets.token_hex(16)}{Path(filename).suffix[:16]}"
    (UPLOAD_DIR / stored).write_bytes(data)
    mime = file.content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"
    a = m.Attachment(task_id=task.id, user_id=user.id, filename=filename, stored_name=stored,
                     size=len(data), mime=mime)
    db.add(a)
    log(db, task.project_id, user, "attachment.added", task, filename=filename)
    db.commit()
    db.refresh(a)
    broadcast_task(db, task, user.id)
    return attachment_out(a)


@router.get("/attachments/{attachment_id}/download")
def download_attachment(attachment_id: int, inline: bool = False,
                        user: m.User = Depends(current_user_or_query_token), db: Session = Depends(get_db)):
    a = get_or_404(db, m.Attachment, attachment_id, "Attachment")
    task_for(db, a.task_id, user)
    path = UPLOAD_DIR / a.stored_name
    if not path.exists():
        raise HTTPException(404, "File missing")
    safe_inline = inline and a.mime.startswith("image/") and a.mime != "image/svg+xml"
    return FileResponse(path, media_type=a.mime if safe_inline else "application/octet-stream",
                        filename=a.filename, content_disposition_type="inline" if safe_inline else "attachment")


@router.delete("/attachments/{attachment_id}")
def delete_attachment(attachment_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    a = get_or_404(db, m.Attachment, attachment_id, "Attachment")
    task = task_for(db, a.task_id, user, "member")
    (UPLOAD_DIR / a.stored_name).unlink(missing_ok=True)
    db.delete(a)
    db.commit()
    broadcast_task(db, task, user.id)
    return {"ok": True}


# ---------------------------------------------------------------- time tracking

def _running(db: Session, user: m.User) -> m.TimeEntry | None:
    return db.scalar(select(m.TimeEntry).where(m.TimeEntry.user_id == user.id, m.TimeEntry.ended_at.is_(None)))


def _stop(entry: m.TimeEntry):
    entry.ended_at = m.utcnow()
    entry.duration_seconds = max(1, int((entry.ended_at - entry.started_at).total_seconds()))


def _timer_out(db: Session, entry: m.TimeEntry | None) -> dict | None:
    if not entry:
        return None
    t = db.get(m.Task, entry.task_id)
    return {**time_entry_out(entry), "task": {"id": t.id, "title": t.title, "number": t.number,
                                              "project_id": t.project_id}}


@router.get("/me/timer")
def my_timer(user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    return _timer_out(db, _running(db, user))


@router.post("/tasks/{task_id}/timer/start")
def start_timer(task_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    task = task_for(db, task_id, user, "member")
    running = _running(db, user)
    if running:
        if running.task_id == task.id:
            return _timer_out(db, running)
        _stop(running)
        broadcast_task(db, db.get(m.Task, running.task_id), user.id)
    entry = m.TimeEntry(task_id=task.id, user_id=user.id)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    broadcast_task(db, task, user.id)
    return _timer_out(db, entry)


@router.post("/me/timer/stop")
def stop_timer(user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    running = _running(db, user)
    if not running:
        return None
    _stop(running)
    task = db.get(m.Task, running.task_id)
    log(db, task.project_id, user, "time.tracked", task, seconds=running.duration_seconds)
    db.commit()
    broadcast_task(db, task, user.id)
    return _timer_out(db, running)


@router.post("/tasks/{task_id}/time")
def add_time(task_id: int, body: TimeIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    task = task_for(db, task_id, user, "member")
    start = _naive(body.date) or (m.utcnow() - timedelta(minutes=body.minutes))
    entry = m.TimeEntry(task_id=task.id, user_id=user.id, started_at=start,
                        ended_at=start + timedelta(minutes=body.minutes),
                        duration_seconds=body.minutes * 60, note=body.note[:300])
    db.add(entry)
    log(db, task.project_id, user, "time.tracked", task, seconds=entry.duration_seconds)
    db.commit()
    db.refresh(entry)
    broadcast_task(db, task, user.id)
    return time_entry_out(entry)


@router.delete("/time-entries/{entry_id}")
def delete_time(entry_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    e = get_or_404(db, m.TimeEntry, entry_id, "Time entry")
    task = task_for(db, e.task_id, user, "member")
    if e.user_id != user.id and membership(db, task.project_id, user.id).role not in ("admin", "owner"):
        raise HTTPException(403, "You can only delete your own time entries")
    db.delete(e)
    db.commit()
    broadcast_task(db, task, user.id)
    return {"ok": True}


# ---------------------------------------------------------------- relations

@router.post("/tasks/{task_id}/relations")
def add_relation(task_id: int, body: RelationIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    task = task_for(db, task_id, user, "member")
    other = task_for(db, body.related_task_id, user)
    if other.id == task.id:
        raise HTTPException(422, "A task can't relate to itself")
    if body.type not in RELATION_TYPES:
        raise HTTPException(422, "Invalid relation type")
    exists = db.scalar(select(m.TaskRelation).where(
        or_((m.TaskRelation.task_id == task.id) & (m.TaskRelation.related_task_id == other.id),
            (m.TaskRelation.task_id == other.id) & (m.TaskRelation.related_task_id == task.id))))
    if exists:
        raise HTTPException(409, "These tasks are already linked")
    db.add(m.TaskRelation(task_id=task.id, related_task_id=other.id, type=body.type))
    log(db, task.project_id, user, "relation.added", task, type=body.type, other=f"#{other.number} {other.title}")
    db.commit()
    broadcast_task(db, task, user.id)
    broadcast_task(db, other, user.id)
    return {"ok": True}


@router.delete("/relations/{relation_id}")
def delete_relation(relation_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    r = get_or_404(db, m.TaskRelation, relation_id, "Relation")
    task = task_for(db, r.task_id, user, "member")
    other = db.get(m.Task, r.related_task_id)
    db.delete(r)
    db.commit()
    broadcast_task(db, task, user.id)
    if other:
        broadcast_task(db, other, user.id)
    return {"ok": True}
