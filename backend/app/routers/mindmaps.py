"""Mind maps per project. Nodes form a tree; any node can be turned into a task and stays linked to it."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import models as m
from ..db import get_db
from ..security import current_user
from ..serializers import iso, project_out, user_out
from ..services import broadcast, get_or_404, log, place_task, require_role

router = APIRouter(prefix="/api", tags=["mindmaps"])


class MapIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    from_board: bool = False


class MapPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=200)
    settings: dict | None = None


class FoldIn(BaseModel):
    level: int | None = None  # show topics down to this depth; None = expand everything


# Display settings: allowed values (choices) or numeric ranges. Anything else is dropped.
SETTING_CHOICES = {
    "layout": ("map", "logic", "left", "vmap", "radial", "bubble", "org", "orgup", "brace", "fishbone", "timeline",
               "vtimeline", "tree", "columns", "outline"),
    "lines": ("curved", "straight", "elbow"),
    "shape": ("rounded", "pill", "rect", "underline", "plain"),
    "palette": ("vibrant", "pastel", "ocean", "sunset", "mono"),
    "background": ("dots", "grid", "plain"),
}
SETTING_RANGES = {"spacing_x": (16, 200), "spacing_y": (2, 60), "font_scale": (0.7, 1.6), "line_width": (0.5, 8)}
SETTING_FLAGS = ("show_tasks", "show_notes")


def clean_settings(raw: dict) -> dict:
    out = {}
    for k, v in (raw or {}).items():
        if k in SETTING_CHOICES and v in SETTING_CHOICES[k]:
            out[k] = v
        elif k in SETTING_RANGES and isinstance(v, (int, float)) and not isinstance(v, bool):
            lo, hi = SETTING_RANGES[k]
            out[k] = max(lo, min(hi, float(v)))
        elif k in SETTING_FLAGS and isinstance(v, bool):
            out[k] = v
    return out


class NodeIn(BaseModel):
    parent_id: int
    text: str = Field("", max_length=500)
    index: int | None = None
    side: str | None = None


class NodePatch(BaseModel):
    text: str | None = Field(None, max_length=500)
    note: str | None = Field(None, max_length=20000)
    color: str | None = None
    collapsed: bool | None = None
    parent_id: int | None = None
    index: int | None = None
    side: str | None = None


class ToTaskIn(BaseModel):
    section_id: int
    mode: str = "single"  # single | children | checklist


# ---------------------------------------------------------------- helpers

def _map(db: Session, map_id: int, user: m.User, minimum: str = "viewer") -> m.MindMap:
    mm = get_or_404(db, m.MindMap, map_id, "Mind map")
    require_role(db, mm.project_id, user, minimum)
    return mm


def _node(db: Session, node_id: int, user: m.User, minimum: str = "member") -> m.MindNode:
    node = get_or_404(db, m.MindNode, node_id, "Node")
    _map(db, node.map_id, user, minimum)
    return node


def _children(db: Session, parent_id: int, exclude: int | None = None) -> list[m.MindNode]:
    q = select(m.MindNode).where(m.MindNode.parent_id == parent_id)
    if exclude:
        q = q.where(m.MindNode.id != exclude)
    return list(db.scalars(q.order_by(m.MindNode.position, m.MindNode.id)))


def _insert(db: Session, node: m.MindNode, parent_id: int, index: int | None):
    siblings = _children(db, parent_id, exclude=node.id)
    if index is None or index > len(siblings):
        index = len(siblings)
    siblings.insert(max(index, 0), node)
    node.parent_id = parent_id
    for i, n in enumerate(siblings):
        n.position = float(i * 1024)


def _touch(db: Session, mm: m.MindMap, user: m.User):
    mm.updated_at = m.utcnow()
    db.commit()
    broadcast(db, mm.project_id, "mindmap.changed", {"map_id": mm.id}, user.id)


def _map_out(mm: m.MindMap, node_count: int | None = None) -> dict:
    return {"id": mm.id, "project_id": mm.project_id, "title": mm.title, "created_by": mm.created_by,
            "created_at": iso(mm.created_at), "updated_at": iso(mm.updated_at), "node_count": node_count,
            "settings": mm.settings or {}}


def _node_out(n: m.MindNode, task: m.Task | None) -> dict:
    return {
        "id": n.id, "parent_id": n.parent_id, "text": n.text, "note": n.note, "color": n.color, "side": n.side,
        "position": n.position, "collapsed": n.collapsed, "task_id": n.task_id,
        "task": {"id": task.id, "number": task.number, "title": task.title, "status": task.status,
                 "assignee": user_out(task.assignee), "due_date": iso(task.due_date),
                 "section_id": task.section_id} if task else None,
    }


def _root(db: Session, map_id: int) -> m.MindNode:
    return db.scalar(select(m.MindNode).where(m.MindNode.map_id == map_id, m.MindNode.parent_id.is_(None)))


# ---------------------------------------------------------------- maps

@router.get("/projects/{project_id}/mindmaps")
def list_maps(project_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user)
    maps = db.scalars(select(m.MindMap).where(m.MindMap.project_id == project_id)
                      .order_by(m.MindMap.updated_at.desc())).all()
    counts = dict(db.execute(select(m.MindNode.map_id, func.count(m.MindNode.id))
                             .where(m.MindNode.map_id.in_([x.id for x in maps])).group_by(m.MindNode.map_id)).all())
    return [_map_out(x, counts.get(x.id, 0)) for x in maps]


@router.post("/projects/{project_id}/mindmaps")
def create_map(project_id: int, body: MapIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "member")
    mm = m.MindMap(project_id=project_id, title=body.title.strip(), created_by=user.id)
    db.add(mm)
    db.flush()
    root = m.MindNode(map_id=mm.id, text=mm.title)
    db.add(root)
    db.flush()
    if body.from_board:
        sections = db.scalars(select(m.Section).where(m.Section.project_id == project_id)
                              .order_by(m.Section.position)).all()
        for i, s in enumerate(sections):
            sn = m.MindNode(map_id=mm.id, parent_id=root.id, text=s.name, color=s.color,
                            side="right" if i % 2 == 0 else "left", position=i * 1024)
            db.add(sn)
            db.flush()
            tasks = db.scalars(select(m.Task).where(m.Task.section_id == s.id, m.Task.status == "open")
                               .order_by(m.Task.position)).all()
            for j, t in enumerate(tasks):
                db.add(m.MindNode(map_id=mm.id, parent_id=sn.id, text=t.title, task_id=t.id, position=j * 1024))
    log(db, project_id, user, "mindmap.created", title=mm.title)
    _touch(db, mm, user)
    return _map_out(mm)


@router.get("/mindmaps/{map_id}")
def get_map(map_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    mm = _map(db, map_id, user)
    nodes = db.scalars(select(m.MindNode).where(m.MindNode.map_id == map_id)
                       .order_by(m.MindNode.position, m.MindNode.id)).all()
    task_ids = [n.task_id for n in nodes if n.task_id]
    tasks = {t.id: t for t in db.scalars(select(m.Task).where(m.Task.id.in_(task_ids)))} if task_ids else {}
    return {"map": _map_out(mm, len(nodes)), "nodes": [_node_out(n, tasks.get(n.task_id)) for n in nodes]}


@router.patch("/mindmaps/{map_id}")
def update_map(map_id: int, body: MapPatch, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    mm = _map(db, map_id, user, "member")
    if body.title is not None:
        old = mm.title
        mm.title = body.title.strip()
        root = _root(db, mm.id)
        if root and (not root.text or root.text == old):
            root.text = mm.title
    if body.settings is not None:
        mm.settings = {**(mm.settings or {}), **clean_settings(body.settings)}
        if body.settings.get("reset"):
            mm.settings = {}
    _touch(db, mm, user)
    return _map_out(mm)


@router.post("/mindmaps/{map_id}/fold")
def fold_map(map_id: int, body: FoldIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    """Collapse every topic at `level` (so deeper ones are hidden), or expand all when level is None."""
    mm = _map(db, map_id, user, "member")
    nodes = db.scalars(select(m.MindNode).where(m.MindNode.map_id == mm.id)).all()
    by_parent: dict = {}
    for n in nodes:
        by_parent.setdefault(n.parent_id, []).append(n)
    stack = [(n, 0) for n in by_parent.get(None, [])]
    while stack:
        n, depth = stack.pop()
        n.collapsed = body.level is not None and depth >= body.level and n.parent_id is not None
        stack.extend((c, depth + 1) for c in by_parent.get(n.id, []))
    _touch(db, mm, user)
    return {"ok": True}


@router.delete("/mindmaps/{map_id}")
def delete_map(map_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    mm = _map(db, map_id, user, "member")
    pid, title = mm.project_id, mm.title
    project = db.get(m.Project, pid)
    if project.kind == "mindmap" and db.scalar(select(func.count(m.MindMap.id)).where(m.MindMap.project_id == pid)) <= 1:
        raise HTTPException(400, "This project is a mind map. Delete the project instead.")
    db.delete(mm)
    log(db, pid, user, "mindmap.deleted", title=title)
    db.commit()
    broadcast(db, pid, "mindmap.changed", {"map_id": map_id, "deleted": True}, user.id)
    return {"ok": True}


# ---------------------------------------------------------------- nodes

@router.post("/mindmaps/{map_id}/nodes")
def add_node(map_id: int, body: NodeIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    mm = _map(db, map_id, user, "member")
    parent = get_or_404(db, m.MindNode, body.parent_id, "Parent node")
    if parent.map_id != mm.id:
        raise HTTPException(422, "Parent belongs to another map")
    side = body.side if body.side in ("left", "right") else None
    if parent.parent_id is None and side is None:
        kids = _children(db, parent.id)
        side = "left" if sum(k.side == "right" for k in kids) > sum(k.side == "left" for k in kids) else "right"
    node = m.MindNode(map_id=mm.id, text=body.text.strip(), side=side or parent.side)
    db.add(node)
    db.flush()
    _insert(db, node, parent.id, body.index)
    parent.collapsed = False
    _touch(db, mm, user)
    return _node_out(node, None)


@router.patch("/mind-nodes/{node_id}")
def update_node(node_id: int, body: NodePatch, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    node = _node(db, node_id, user)
    mm = db.get(m.MindMap, node.map_id)
    data = body.model_dump(exclude_unset=True)
    if "text" in data:
        node.text = (data["text"] or "").strip()
        if node.parent_id is None and node.text:
            mm.title = node.text
            project = db.get(m.Project, mm.project_id)
            if project.kind == "mindmap" and project.name != node.text:
                project.name = node.text[:160]
                db.flush()
                broadcast(db, project.id, "project.updated", {"project": project_out(project)}, user.id)
    for k in ("note", "color", "collapsed"):
        if k in data:
            setattr(node, k, data[k])
    if "side" in data and data["side"] in ("left", "right"):
        node.side = data["side"]
    if "parent_id" in data or "index" in data:
        if node.parent_id is None:
            raise HTTPException(400, "The central topic can't be moved")
        new_parent_id = data.get("parent_id") or node.parent_id
        new_parent = get_or_404(db, m.MindNode, new_parent_id, "Parent node")
        if new_parent.map_id != node.map_id:
            raise HTTPException(422, "Parent belongs to another map")
        cursor = new_parent
        while cursor is not None:  # no cycles: the new parent can't be inside the moved subtree
            if cursor.id == node.id:
                raise HTTPException(400, "Can't move a topic into its own subtree")
            cursor = db.get(m.MindNode, cursor.parent_id) if cursor.parent_id else None
        _insert(db, node, new_parent.id, data.get("index"))
        new_parent.collapsed = False
    _touch(db, mm, user)
    task = db.get(m.Task, node.task_id) if node.task_id else None
    return _node_out(node, task)


@router.delete("/mind-nodes/{node_id}")
def delete_node(node_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    node = _node(db, node_id, user)
    if node.parent_id is None:
        raise HTTPException(400, "The central topic can't be deleted")
    mm = db.get(m.MindMap, node.map_id)
    # delete the whole subtree explicitly (works even without DB-level cascades)
    stack, doomed = [node.id], []
    while stack:
        nid = stack.pop()
        doomed.append(nid)
        stack.extend(db.scalars(select(m.MindNode.id).where(m.MindNode.parent_id == nid)))
    for nid in reversed(doomed):
        db.delete(db.get(m.MindNode, nid))
    _touch(db, mm, user)
    return {"ok": True, "deleted": len(doomed)}


@router.post("/mind-nodes/{node_id}/to-task")
def node_to_task(node_id: int, body: ToTaskIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    node = _node(db, node_id, user)
    mm = db.get(m.MindMap, node.map_id)
    section = get_or_404(db, m.Section, body.section_id, "Section")
    if section.project_id != mm.project_id:
        raise HTTPException(422, "Section belongs to another project")
    project = db.get(m.Project, mm.project_id)

    def make(n: m.MindNode, checklist_from: list[m.MindNode] | None = None) -> m.Task | None:
        if n.task_id or not n.text.strip():
            return None
        project.task_counter += 1
        t = m.Task(project_id=project.id, section_id=section.id, number=project.task_counter,
                   title=n.text.strip()[:300], description=n.note or "", creator_id=user.id)
        t.watchers = [user]
        if checklist_from:
            cl = m.Checklist(name="Checklist", position=0)
            cl.items = [m.ChecklistItem(text=c.text.strip()[:500], position=i * 1024)
                        for i, c in enumerate(checklist_from) if c.text.strip()]
            t.checklists.append(cl)
        db.add(t)
        db.flush()
        place_task(db, t, section.id, None)
        n.task_id = t.id
        log(db, project.id, user, "task.created", t, section=section.name, from_mindmap=mm.title)
        return t

    if body.mode == "children":
        created = [t for c in _children(db, node.id) if (t := make(c))]
    elif body.mode == "checklist":
        created = [t for t in [make(node, _children(db, node.id))] if t]
    else:
        created = [t for t in [make(node)] if t]
    if not created:
        raise HTTPException(400, "Nothing to convert: these topics are empty or already linked to tasks")
    _touch(db, mm, user)
    broadcast(db, project.id, "board.changed", {}, user.id)
    return {"created": [{"id": t.id, "number": t.number, "title": t.title} for t in created]}


@router.post("/mind-nodes/{node_id}/unlink")
def unlink_task(node_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    node = _node(db, node_id, user)
    node.task_id = None
    _touch(db, db.get(m.MindMap, node.map_id), user)
    return {"ok": True}
