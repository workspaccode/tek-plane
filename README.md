# 6dx

Collaborative task management: Kanban boards, mind maps, automations, time tracking and a personal agenda.

**Stack:** FastAPI + SQLAlchemy (SQLite by default) · vanilla HTML/CSS/JS (ES modules, no build step) · WebSockets for live updates.

## Run

```bash
./run.sh              # http://localhost:8000
PORT=9000 ./run.sh    # another port
./run.sh --reload     # auto-reload while developing
./run.sh --lan        # share on your Wi-Fi: other devices open http://<this-computer-ip>:8000

```

Requires [uv](https://docs.astral.sh/uv/). The first run creates `data/` with the SQLite database, uploaded files and a generated signing key.

## Sign-in

No passwords. People sign in with **Google** (name, photo and email come from the Google account) or with their **email**: they get one email holding a **6-digit code and a one-click link**. For a new account that email is an *Activate your account* email; clicking the link activates the account and signs in. Codes and links expire after 10 minutes and work once (5 code attempts, resend after 30 s, max 6 codes per hour). Inviting an email to a project creates the account and sends an *Accept invitation* link (valid 7 days) that signs the person straight into that project. Accounts record whether the email is verified.

Copy `.env.example` to `.env`, fill in **one** email option and (optionally) Google, then restart:

- **Email via Resend**: set `RESEND_API_KEY` (and `EMAIL_FROM` once your domain is verified).
- **Email via SMTP / Gmail**: set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`. Gmail requires an App Password (https://myaccount.google.com/apppasswords), not your normal password.
- **Test it**: `uv run python -m backend.app.mailer you@example.com` sends a real email and explains any failure. Delivery problems while the app runs are printed in the server terminal with a hint.
- **Google**: create an OAuth client ("Web application") and add `<your URL>/api/auth/google/callback` as an authorized redirect URI; set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Without an email option, codes and links are printed in the server terminal (development mode), and the sign-in page says so.

Change the password after your first sign-in: it's written in plain text in this conversation. Go to Profile & settings, then the Password card. Changing it also signs out any other device.

If you forget the password, reset it from the terminal. It asks for the password hidden and doesn't store it in history:


uv run python -m backend.app.manage set-password mahhafez
The same tool can create more admins (create-admin) and list them all (list-admins).



## Features

- **Project types** (chosen when creating): **Board** (default) or **Mind map**, where the whole project is one map that opens straight into the canvas, with only Mind Map / Activity / Settings. A mind map project can get a board later (*Add a board*); the map stays and topics can then become tasks. Renaming the central topic renames the project and vice versa.
- **Projects & teams**: templates (Kanban, Scrum, Personal, Content, Blank), colors/icons, archive, roles (owner / admin / member / viewer), invite by email, ownership transfer.
- **Board**: sections with colors, icons and WIP limits; drag & drop tasks and sections; inline quick add; filters (text, assignee, tags, due, priority, completed).
- **Tasks**: markdown description with @mentions, assignee, watchers, due/start dates, priority, tags, recurrence (daily/weekly/monthly), checklists, comments, file attachments, task links (blocks/relates/duplicates), duplicate, move to another project, archive.
- **Section automations**: when a task enters a section → complete, reopen, assign, add tag, set due date, add checklist, add watcher, set priority.
- **Views**: Board, List (sort, group, bulk actions), Timeline (Gantt), Mind Map, Reports, Activity.
- **Mind maps**: several per project, auto layout around a central topic, pan/zoom, drag to re-parent, colors, notes, collapse; keyboard first (Tab = sub-topic, Enter = sibling, F2 = edit, Space = fold, Del = delete, arrows = move). Turn a topic into a task, its sub-topics into a checklist, or each sub-topic into its own task. Linked topics show live task status. A map can also be generated from the board.
- **Mind map display**: 15 layouts in three groups (Maps: Mind Map, Logic Chart, Left Logic, Vertical Map, Radial, Bubble Map · Charts: Org Chart, Org Chart Up, Brace Map, Fishbone, Timeline, Vertical Timeline · Lists: Tree, Columns, Outline) and a Display panel: branch lines (curved / straight / elbow), topic shape (rounded / pill / box / underline / text), 5 color palettes, horizontal & vertical spacing, text size, branch thickness, background (dots / grid / plain), show/hide task badges and notes, expand all / collapse to level 1–3, reset. Settings are saved per map for everyone (viewers can change them locally). Arrow keys follow the layout's direction.
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
| `RESEND_API_KEY`, `EMAIL_FROM` | empty | Email delivery through Resend |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | empty | Email delivery through SMTP |

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
