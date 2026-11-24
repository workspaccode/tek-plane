# tek-plane

Collaborative task management: Kanban boards, mind maps, automations, time tracking and a personal agenda.

**Stack:** FastAPI + SQLAlchemy (SQLite by default) · vanilla HTML/CSS/JS (ES modules, no build step) · WebSockets for live updates.

## Run

```bash
./run.sh              # http://localhost:8000
PORT=9000 ./run.sh    # another port
./run.sh --reload     # auto-reload while developing
```

Requires [uv](https://docs.astral.sh/uv/). The first run creates `data/` with the SQLite database, uploaded files and a generated signing key.

## Sign-in

No passwords. People sign in with **Google** or with a **6-digit code sent by email** (valid 10 minutes, 5 attempts, resend after 30 s, max 6 codes per hour). Signing in for the first time creates the account; inviting an email to a project also creates the account and emails an invitation.

Copy `.env.example` to `.env` and fill in:

- **Google**: create an OAuth client ("Web application") in Google Cloud Console and add `<your URL>/api/auth/google/callback` as an authorized redirect URI. The button appears on the login page once `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
- **Email**: set the `SMTP_*` values. Until then, codes and invitations are printed in the server terminal, which is handy for local development.

## Features

- **Project types** (chosen when creating): **Board** (default) or **Mind map**, where the whole project is one map that opens straight into the canvas, with only Mind Map / Activity / Settings. A mind map project can get a board later (*Add a board*); the map stays and topics can then become tasks. Renaming the central topic renames the project and vice versa.
- **Projects & teams**: templates (Kanban, Scrum, Personal, Content, Blank), colors/icons, archive, roles (owner / admin / member / viewer), invite by email, ownership transfer.
- **Board**: sections with colors, icons and WIP limits; drag & drop tasks and sections; inline quick add; filters (text, assignee, tags, due, priority, completed).
- **Tasks**: markdown description with @mentions, assignee, watchers, due/start dates, priority, tags, recurrence (daily/weekly/monthly), checklists, comments, file attachments, task links (blocks/relates/duplicates), duplicate, move to another project, archive.
- **Section automations**: when a task enters a section → complete, reopen, assign, add tag, set due date, add checklist, add watcher, set priority.
- **Views**: Board, List (sort, group, bulk actions), Timeline (Gantt), Mind Map, Reports, Activity.
- **Mind maps**: several per project, auto layout around a central topic, pan/zoom, drag to re-parent, colors, notes, collapse; keyboard first (Tab = sub-topic, Enter = sibling, F2 = edit, Space = fold, Del = delete, arrows = move). Turn a topic into a task, its sub-topics into a checklist, or each sub-topic into its own task. Linked topics show live task status. A map can also be generated from the board.
- **Mind map display**: 5 layouts (Mind Map, Logic Chart, Org Chart, Tree, Radial) and a Display panel: branch lines (curved / straight / elbow), topic shape (rounded / pill / box / underline / text), 5 color palettes, horizontal & vertical spacing, text size, branch thickness, background (dots / grid / plain), show/hide task badges and notes, expand all / collapse to level 1–3, reset. Settings are saved per map for everyone (viewers can change them locally). Arrow keys follow the layout's direction.
- **Personal**: Dashboard, My Tasks, Agenda (personal board of pinned tasks), Time Tracking report with CSV export.
- **Time tracking**: start/stop timer (one running timer per user), manual entries, estimates.
- **Collaboration**: real-time sync, presence, in-app notifications, global search (⌘K).
- Design: Liquid Glass chrome (frosted floating sidebar, dialogs, menus and toolbars) with Notion-style content (warm neutrals, pastel tags, property rows). Light/dark/system theme, respects reduced transparency, keyboard shortcuts (press `?`), responsive layout.

## Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `TEKPLANE_DATA_DIR` | `./data` | Database, uploads, secret key |
| `TEKPLANE_DATABASE_URL` | `sqlite:///data/tekplane.db` | Any SQLAlchemy URL (e.g. Postgres; add the driver) |
| `TEKPLANE_SECRET` | generated | JWT signing key |
| `TEKPLANE_MAX_UPLOAD_MB` | `25` | Attachment size limit |
| `TEKPLANE_TOKEN_TTL_HOURS` | `336` | Login session length |
| `TEKPLANE_BASE_URL` | request URL | Public URL, used for the Google redirect and invite links |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | empty | Enables "Continue with Google" |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | empty | Email delivery for login codes and invites |

## Layout

```
backend/app/
  main.py          app, WebSocket endpoint, static + SPA fallback
  models.py        SQLAlchemy models
  services.py      permissions, activity log, notifications, automations, recurrence
  serializers.py   JSON output
  mailer.py        SMTP email (console fallback)
  routers/         auth (Google + email code), mindmaps, projects, sections (+automations, tags), tasks (+checklists, comments,
                   attachments, time, relations), personal (dashboard, my tasks, agenda,
                   notifications, search, time report)
frontend/
  index.html, css/ (theme.css = Liquid Glass × Notion layer), js/app.js (shell + routes), js/views/*, js/components/*
tests/test_api.py  end-to-end API test
```

API docs: `http://localhost:8000/docs`.

## Tests

```bash
uv run pytest
```

Note: the in-process WebSocket hub assumes a single server process. Running several workers needs a shared broker (e.g. Redis pub/sub).
