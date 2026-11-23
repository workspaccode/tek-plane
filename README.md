# tek-plane

Collaborative Kanban task management: projects, boards, automations, time tracking and a personal agenda.

**Stack:** FastAPI + SQLAlchemy (SQLite by default) · vanilla HTML/CSS/JS (ES modules, no build step) · WebSockets for live updates.

## Run

```bash
./run.sh              # http://localhost:8000
PORT=9000 ./run.sh    # another port
./run.sh --reload     # auto-reload while developing
```

Requires [uv](https://docs.astral.sh/uv/). The first run creates `data/` with the SQLite database, uploaded files and a generated signing key.

## Features

- **Projects & teams**: templates (Kanban, Scrum, Personal, Content, Blank), colors/icons, archive, roles (owner / admin / member / viewer), invite by email, ownership transfer.
- **Board**: sections with colors, icons and WIP limits; drag & drop tasks and sections; inline quick add; filters (text, assignee, tags, due, priority, completed).
- **Tasks**: markdown description with @mentions, assignee, watchers, due/start dates, priority, tags, recurrence (daily/weekly/monthly), checklists, comments, file attachments, task links (blocks/relates/duplicates), duplicate, move to another project, archive.
- **Section automations**: when a task enters a section → complete, reopen, assign, add tag, set due date, add checklist, add watcher, set priority.
- **Views**: Board, List (sort, group, bulk actions), Timeline (Gantt), Reports, Activity.
- **Personal**: Dashboard, My Tasks, Agenda (personal board of pinned tasks), Time Tracking report with CSV export.
- **Time tracking**: start/stop timer (one running timer per user), manual entries, estimates.
- **Collaboration**: real-time sync, presence, in-app notifications, global search (⌘K).
- Dark mode, keyboard shortcuts (press `?`), responsive layout.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `TEKPLANE_DATA_DIR` | `./data` | Database, uploads, secret key |
| `TEKPLANE_DATABASE_URL` | `sqlite:///data/tekplane.db` | Any SQLAlchemy URL (e.g. Postgres; add the driver) |
| `TEKPLANE_SECRET` | generated | JWT signing key |
| `TEKPLANE_MAX_UPLOAD_MB` | `25` | Attachment size limit |
| `TEKPLANE_TOKEN_TTL_HOURS` | `336` | Login session length |

## Layout

```
backend/app/
  main.py          app, WebSocket endpoint, static + SPA fallback
  models.py        SQLAlchemy models
  services.py      permissions, activity log, notifications, automations, recurrence
  serializers.py   JSON output
  routers/         auth, projects, sections (+automations, tags), tasks (+checklists, comments,
                   attachments, time, relations), personal (dashboard, my tasks, agenda,
                   notifications, search, time report)
frontend/
  index.html, css/, js/app.js (shell + routes), js/views/*, js/components/*
tests/test_api.py  end-to-end API test
```

API docs: `http://localhost:8000/docs`.

## Tests

```bash
uv run pytest
```

Note: the in-process WebSocket hub assumes a single server process. Running several workers needs a shared broker (e.g. Redis pub/sub).
