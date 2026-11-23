from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import models as m
from ..db import get_db
from ..security import current_user
from ..serializers import automation_out, section_out, tag_out
from ..services import (
    AUTOMATION_TYPES,
    broadcast,
    get_or_404,
    log,
    next_position,
    place_task,
    require_role,
)

router = APIRouter(prefix="/api", tags=["sections"])


class SectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    color: str = "#8792a2"
    icon: str = "circle"
    wip_limit: int | None = None


class SectionPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    color: str | None = None
    icon: str | None = None
    wip_limit: int | None = None


class ReorderIn(BaseModel):
    ids: list[int]


class AutomationIn(BaseModel):
    type: str
    config: dict = {}
    active: bool = True


class AutomationPatch(BaseModel):
    config: dict | None = None
    active: bool | None = None


class TagIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    color: str = "#8792a2"


class TagPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=60)
    color: str | None = None


def _section(db: Session, section_id: int, user: m.User, minimum: str) -> m.Section:
    s = get_or_404(db, m.Section, section_id, "Section")
    require_role(db, s.project_id, user, minimum)
    return s


@router.post("/projects/{project_id}/sections")
def create_section(project_id: int, body: SectionIn, user: m.User = Depends(current_user),
                   db: Session = Depends(get_db)):
    require_role(db, project_id, user, "admin")
    s = m.Section(project_id=project_id, **body.model_dump(),
                  position=next_position(db, m.Section.position, m.Section.project_id == project_id))
    db.add(s)
    log(db, project_id, user, "section.created", name=s.name)
    db.commit()
    db.refresh(s)
    broadcast(db, project_id, "board.changed", {}, user.id)
    return section_out(s)


@router.patch("/sections/{section_id}")
def update_section(section_id: int, body: SectionPatch, user: m.User = Depends(current_user),
                   db: Session = Depends(get_db)):
    s = _section(db, section_id, user, "admin")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(s, k, v)
    db.commit()
    broadcast(db, s.project_id, "board.changed", {}, user.id)
    return section_out(s)


@router.delete("/sections/{section_id}")
def delete_section(section_id: int, move_to: int | None = None, user: m.User = Depends(current_user),
                   db: Session = Depends(get_db)):
    s = _section(db, section_id, user, "admin")
    project_id = s.project_id
    others = db.scalars(select(m.Section).where(m.Section.project_id == project_id, m.Section.id != s.id)).all()
    if not others:
        raise HTTPException(400, "A project needs at least one section")
    tasks = db.scalars(select(m.Task).where(m.Task.section_id == s.id)).all()
    if tasks:
        target = next((o for o in others if o.id == move_to), None)
        if not target:
            raise HTTPException(400, "Choose a section to move this section's tasks to")
        for t in sorted(tasks, key=lambda t: t.position):
            place_task(db, t, target.id, None) if t.status == "open" else setattr(t, "section_id", target.id)
    log(db, project_id, user, "section.deleted", name=s.name)
    db.flush()
    db.delete(s)
    db.commit()
    broadcast(db, project_id, "board.changed", {}, user.id)
    return {"ok": True}


@router.post("/projects/{project_id}/sections/reorder")
def reorder_sections(project_id: int, body: ReorderIn, user: m.User = Depends(current_user),
                     db: Session = Depends(get_db)):
    require_role(db, project_id, user, "admin")
    sections = {s.id: s for s in db.scalars(select(m.Section).where(m.Section.project_id == project_id))}
    if set(body.ids) != set(sections):
        raise HTTPException(400, "Section list mismatch")
    for i, sid in enumerate(body.ids):
        sections[sid].position = float(i * 1024)
    db.commit()
    broadcast(db, project_id, "board.changed", {}, user.id)
    return {"ok": True}


# ---------------------------------------------------------------- automations

@router.post("/sections/{section_id}/automations")
def create_automation(section_id: int, body: AutomationIn, user: m.User = Depends(current_user),
                      db: Session = Depends(get_db)):
    s = _section(db, section_id, user, "admin")
    if body.type not in AUTOMATION_TYPES:
        raise HTTPException(422, "Unknown automation type")
    a = m.Automation(section_id=s.id, type=body.type, config=body.config, active=body.active)
    db.add(a)
    log(db, s.project_id, user, "automation.created", section=s.name, type=body.type)
    db.commit()
    broadcast(db, s.project_id, "board.changed", {}, user.id)
    return automation_out(a)


@router.patch("/automations/{automation_id}")
def update_automation(automation_id: int, body: AutomationPatch, user: m.User = Depends(current_user),
                      db: Session = Depends(get_db)):
    a = get_or_404(db, m.Automation, automation_id, "Automation")
    s = _section(db, a.section_id, user, "admin")
    if body.config is not None:
        a.config = body.config
    if body.active is not None:
        a.active = body.active
    db.commit()
    broadcast(db, s.project_id, "board.changed", {}, user.id)
    return automation_out(a)


@router.delete("/automations/{automation_id}")
def delete_automation(automation_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    a = get_or_404(db, m.Automation, automation_id, "Automation")
    s = _section(db, a.section_id, user, "admin")
    db.delete(a)
    db.commit()
    broadcast(db, s.project_id, "board.changed", {}, user.id)
    return {"ok": True}


# ---------------------------------------------------------------- tags

@router.post("/projects/{project_id}/tags")
def create_tag(project_id: int, body: TagIn, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    require_role(db, project_id, user, "member")
    t = m.Tag(project_id=project_id, name=body.name.strip(), color=body.color)
    db.add(t)
    db.commit()
    broadcast(db, project_id, "board.changed", {}, user.id)
    return tag_out(t)


@router.patch("/tags/{tag_id}")
def update_tag(tag_id: int, body: TagPatch, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    t = get_or_404(db, m.Tag, tag_id, "Tag")
    require_role(db, t.project_id, user, "member")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(t, k, v)
    db.commit()
    broadcast(db, t.project_id, "board.changed", {}, user.id)
    return tag_out(t)


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: int, user: m.User = Depends(current_user), db: Session = Depends(get_db)):
    t = get_or_404(db, m.Tag, tag_id, "Tag")
    require_role(db, t.project_id, user, "admin")
    pid = t.project_id
    db.delete(t)
    db.commit()
    broadcast(db, pid, "board.changed", {}, user.id)
    return {"ok": True}
