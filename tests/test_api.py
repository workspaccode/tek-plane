import os
import tempfile
import time

os.environ["TEKPLANE_DATA_DIR"] = tempfile.mkdtemp()
# never use the real GitHub App from .env in tests (real env vars win over .env)
for _key in ("GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_PRIVATE_KEY_PATH", "GITHUB_WEBHOOK_SECRET",
             "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"):
    os.environ[_key] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.app.main import app  # noqa: E402


SENT = {}
LINKS = {}
INVITES = {}


@pytest.fixture(autouse=True)
def capture_codes(monkeypatch):
    from backend.app import mailer
    monkeypatch.setattr(mailer, "send_login_email", lambda to, code, link, is_new: (
        SENT.__setitem__(to, code), LINKS.__setitem__(to, (link, is_new))))
    monkeypatch.setattr(mailer, "send_invite_email", lambda to, inviter, project, link: INVITES.__setitem__(to, link))
    monkeypatch.setattr(mailer, "send_email", lambda *a, **k: None)


def login(c, email, name=None):
    r = c.post("/api/auth/otp/request", json={"email": email})
    assert r.status_code == 200, r.text
    r = c.post("/api/auth/otp/verify", json={"email": email, "code": SENT[email]})
    assert r.status_code == 200, r.text
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    if name:
        c.patch("/api/me", json={"name": name}, headers=h)
    return h, c.get("/api/me", headers=h).json()


register = login


def test_full_flow():
    with TestClient(app) as c:
        h1, u1 = register(c, "a@x.io", "Alice")
        h2, u2 = register(c, "b@x.io", "Bob")

        p = c.post("/api/projects", json={"name": "Launch", "template": "kanban"}, headers=h1).json()
        board = c.get(f"/api/projects/{p['id']}", headers=h1).json()
        sections = board["sections"]
        assert [s["name"] for s in sections] == ["Open", "In Progress", "Review", "Done"]
        assert sections[-1]["automations"][0]["type"] == "complete"

        # Bob can't see it until invited
        assert c.get(f"/api/projects/{p['id']}", headers=h2).status_code == 404
        assert c.post(f"/api/projects/{p['id']}/members", json={"email": "b@x.io", "role": "member"},
                      headers=h1).status_code == 200
        assert c.get(f"/api/projects/{p['id']}", headers=h2).status_code == 200

        open_id, done_id = sections[0]["id"], sections[-1]["id"]
        t1 = c.post(f"/api/projects/{p['id']}/tasks", json={"title": "Write spec", "section_id": open_id,
                    "assignee_id": u2["id"], "due_date": "2026-12-01T10:00:00Z"}, headers=h1).json()
        t2 = c.post(f"/api/projects/{p['id']}/tasks", json={"title": "Design", "section_id": open_id,
                    "index": 0}, headers=h1).json()
        assert t1["number"] == 1 and t2["number"] == 2
        board = c.get(f"/api/projects/{p['id']}", headers=h1).json()
        order = [t["id"] for t in sorted(board["tasks"], key=lambda t: t["position"])]
        assert order == [t2["id"], t1["id"]]

        # Bob got an assignment notification
        n = c.get("/api/notifications", headers=h2).json()
        assert n["unread"] == 2 and [i["type"] for i in n["items"]] == ["task.assigned", "project.invited"]

        # Checklist, comment with mention, time, relation
        cl = c.post(f"/api/tasks/{t1['id']}/checklists", json={"name": "Steps", "items": ["a", "b"]}, headers=h1).json()
        c.patch(f"/api/checklist-items/{cl['items'][0]['id']}", json={"done": True}, headers=h2)
        c.post(f"/api/tasks/{t1['id']}/comments", json={"body": f"Hey @[Alice]({u1['id']}) look"}, headers=h2)
        assert c.get("/api/notifications", headers=h1).json()["items"][0]["type"] == "mention"
        c.post(f"/api/tasks/{t1['id']}/time", json={"minutes": 30}, headers=h2)
        timer = c.post(f"/api/tasks/{t2['id']}/timer/start", headers=h2).json()
        assert timer["running"]
        assert c.get("/api/me/timer", headers=h2).json()["task"]["id"] == t2["id"]
        c.post("/api/me/timer/stop", headers=h2)
        assert c.post(f"/api/tasks/{t1['id']}/relations", json={"related_task_id": t2["id"], "type": "blocks"},
                      headers=h1).status_code == 200

        # Attachment
        r = c.post(f"/api/tasks/{t1['id']}/attachments", files={"file": ("notes.txt", b"hello", "text/plain")},
                   headers=h1)
        att = r.json()
        token = h1["Authorization"].split()[1]
        assert c.get(f"{att['url']}?token={token}").content == b"hello"

        detail = c.get(f"/api/tasks/{t1['id']}", headers=h1).json()
        assert detail["checklist_done"] == 1 and detail["checklist_total"] == 2
        assert detail["comments"] == 1 or len(detail["comments"]) == 1
        assert detail["time_seconds"] == 1800
        assert detail["relations"][0]["label"] == "blocks"

        # Move to Done triggers completion automation; recurrence spawns next
        c.patch(f"/api/tasks/{t1['id']}", json={"recurrence": "weekly"}, headers=h1)
        moved = c.post(f"/api/tasks/{t1['id']}/move", json={"section_id": done_id}, headers=h1).json()
        assert moved["status"] == "completed"
        board = c.get(f"/api/projects/{p['id']}", headers=h1).json()
        spawned = [t for t in board["tasks"] if t["title"] == "Write spec" and t["status"] == "open"]
        assert len(spawned) == 1 and spawned[0]["due_date"].startswith("2026-12-08")

        # Viewer can't edit
        h3, u3 = register(c, "c@x.io", "Cara")
        c.post(f"/api/projects/{p['id']}/members", json={"email": "c@x.io", "role": "viewer"}, headers=h1)
        assert c.patch(f"/api/tasks/{t2['id']}", json={"title": "x"}, headers=h3).status_code == 403

        # Personal endpoints
        assert len(c.get("/api/me/tasks", headers=h2).json()) == 1
        dash = c.get("/api/dashboard", headers=h2).json()
        assert dash["counts"]["open"] == 1
        pin = c.post("/api/agenda/pins", json={"task_id": t2["id"]}, headers=h2).json()
        ag = c.get("/api/agenda", headers=h2).json()
        assert len(ag["sections"]) == 3 and ag["pins"][0]["task"]["id"] == t2["id"]
        c.post(f"/api/agenda/pins/{pin['id']}/move", json={"section_id": ag["sections"][1]["id"], "index": 0},
               headers=h2)
        assert c.get("/api/search?q=design", headers=h1).json()["tasks"][0]["id"] == t2["id"]
        assert c.get("/api/search?q=%232", headers=h1).json()["tasks"][0]["id"] == t2["id"]
        stats = c.get(f"/api/projects/{p['id']}/stats", headers=h1).json()
        assert stats["totals"]["completed"] == 1
        assert len(c.get("/api/reports/time", headers=h1).json()) == 2
        assert len(c.get(f"/api/projects/{p['id']}/activity", headers=h1).json()) > 5

        # Section delete requires a target when non-empty
        assert c.delete(f"/api/sections/{open_id}", headers=h1).status_code == 400
        assert c.delete(f"/api/sections/{open_id}?move_to={sections[1]['id']}", headers=h1).status_code == 200

        # Duplicate & bulk
        dup = c.post(f"/api/tasks/{t2['id']}/duplicate", headers=h1).json()
        assert dup["title"] == "Design (copy)"
        assert c.post(f"/api/projects/{p['id']}/tasks/bulk", json={"task_ids": [dup["id"]], "action": "archive"},
                      headers=h1).json()["count"] == 1

        # SPA fallback and websocket auth
        assert c.get("/projects/1").status_code == 200
        with c.websocket_connect(f"/ws?token={token}") as ws:
            assert "presence" in ws.receive_text()
            ws.send_text("ping")
            assert "pong" in ws.receive_text()


def test_otp_rules(monkeypatch):
    from backend.app import config
    for key in ("RESEND_API_KEY", "SMTP_HOST", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"):
        monkeypatch.setattr(config, key, "")  # ignore the developer's own .env
    with TestClient(app) as c:
        assert c.post("/api/auth/otp/request", json={"email": "not-an-email"}).status_code == 422
        r = c.post("/api/auth/otp/request", json={"email": "Otp@X.io"})
        assert r.json()["is_new"] is True
        # resend throttled
        assert c.post("/api/auth/otp/request", json={"email": "otp@x.io"}).status_code == 429
        code = SENT["otp@x.io"]
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(5):
            assert c.post("/api/auth/otp/verify", json={"email": "otp@x.io", "code": wrong}).status_code == 400
        # locked after 5 wrong attempts, even with the right code
        assert c.post("/api/auth/otp/verify", json={"email": "otp@x.io", "code": code}).status_code == 429
        cfg = c.get("/api/auth/config").json()
        assert cfg["google"] is False and cfg["email_delivery"] == "console"
        # Google start without config sends the user back to login with an error
        r = c.get("/api/auth/google/start", follow_redirects=False)
        assert r.status_code == 302 and r.headers["location"].startswith("/login#error=")
        # passwords are gone
        assert c.post("/api/auth/login", json={"email": "a", "password": "b"}).status_code in (404, 405)


def test_google_start_redirect(monkeypatch):
    from backend.app import config
    monkeypatch.setattr(config, "GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setattr(config, "GOOGLE_CLIENT_SECRET", "secret")
    monkeypatch.setattr(config, "BASE_URL", "")
    # opened over Wi-Fi by IP: Google refuses such redirects, so the button is hidden and start bounces back
    with TestClient(app, base_url="http://192.168.1.20:8000") as c:
        cfg = c.get("/api/auth/config").json()
        assert cfg["google"] is False and cfg["google_configured"] and not cfg["google_via_localhost"]
        r = c.get("/api/auth/google/start", follow_redirects=False)
        assert r.headers["location"].startswith("/login#error=")
    with TestClient(app, base_url="http://localhost:8000") as c:
        assert c.get("/api/auth/config").json()["google"] is True
        r = c.get("/api/auth/google/start?next=//evil.com", follow_redirects=False)
        loc = r.headers["location"]
        assert loc.startswith("https://accounts.google.com/") and "code_challenge_method=S256" in loc
        assert "tp_oauth" in r.headers["set-cookie"]
        # callback with a mismatched state is rejected
        r = c.get("/api/auth/google/callback?code=x&state=wrong", follow_redirects=False)
        assert r.headers["location"].startswith("/login#error=")


def test_invite_creates_account_and_mindmap():
    with TestClient(app) as c:
        h1, u1 = login(c, "owner@m.io", "Owner")
        p = c.post("/api/projects", json={"name": "Maps", "template": "personal"}, headers=h1).json()
        # inviting an unknown email creates the account; they can then log in with a code
        assert c.post(f"/api/projects/{p['id']}/members", json={"email": "newbie@m.io"}, headers=h1).status_code == 200
        h2, u2 = login(c, "newbie@m.io")
        assert u2["name"] == "newbie"
        assert c.get(f"/api/projects/{p['id']}", headers=h2).status_code == 200

        board = c.get(f"/api/projects/{p['id']}", headers=h1).json()
        sec = board["sections"][0]["id"]
        c.post(f"/api/projects/{p['id']}/tasks", json={"title": "Existing", "section_id": sec}, headers=h1)
        mm = c.post(f"/api/projects/{p['id']}/mindmaps", json={"title": "Plan", "from_board": True}, headers=h1).json()
        data = c.get(f"/api/mindmaps/{mm['id']}", headers=h1).json()
        root = next(n for n in data["nodes"] if n["parent_id"] is None)
        assert len(data["nodes"]) == 1 + len(board["sections"]) + 1
        assert any(n["task"] and n["task"]["title"] == "Existing" for n in data["nodes"])

        a = c.post(f"/api/mindmaps/{mm['id']}/nodes", json={"parent_id": root["id"], "text": "Launch"}, headers=h2).json()
        b = c.post(f"/api/mindmaps/{mm['id']}/nodes", json={"parent_id": a["id"], "text": "Write post"}, headers=h2).json()
        c.post(f"/api/mindmaps/{mm['id']}/nodes", json={"parent_id": a["id"], "text": "Send email"}, headers=h2)
        # no cycles
        assert c.patch(f"/api/mind-nodes/{a['id']}", json={"parent_id": b["id"]}, headers=h1).status_code == 400
        assert c.delete(f"/api/mind-nodes/{root['id']}", headers=h1).status_code == 400
        # node -> task with children as checklist
        r = c.post(f"/api/mind-nodes/{a['id']}/to-task", json={"section_id": sec, "mode": "checklist"}, headers=h1).json()
        t = c.get(f"/api/tasks/{r['created'][0]['id']}", headers=h1).json()
        assert t["title"] == "Launch" and [i["text"] for i in t["checklists"][0]["items"]] == ["Write post", "Send email"]
        # children -> tasks
        r = c.post(f"/api/mind-nodes/{a['id']}/to-task", json={"section_id": sec, "mode": "children"}, headers=h1).json()
        assert len(r["created"]) == 2
        # converting again is a no-op error
        assert c.post(f"/api/mind-nodes/{a['id']}/to-task", json={"section_id": sec, "mode": "children"},
                      headers=h1).status_code == 400
        # move subtree, then delete it
        assert c.patch(f"/api/mind-nodes/{b['id']}", json={"parent_id": root["id"], "index": 0}, headers=h1).status_code == 200
        assert c.delete(f"/api/mind-nodes/{a['id']}", headers=h1).json()["deleted"] == 2
        assert len(c.get(f"/api/projects/{p['id']}/mindmaps", headers=h1).json()) == 1
        assert c.delete(f"/api/mindmaps/{mm['id']}", headers=h1).status_code == 200


def test_mindmap_project():
    with TestClient(app) as c:
        h, _ = login(c, "mapper@m.io", "Mapper")
        p = c.post("/api/projects", json={"name": "Ideas", "kind": "mindmap", "icon": "mindmap"}, headers=h).json()
        assert p["kind"] == "mindmap"
        board = c.get(f"/api/projects/{p['id']}", headers=h).json()
        assert board["sections"] == [] and board["tags"] == []
        maps = c.get(f"/api/projects/{p['id']}/mindmaps", headers=h).json()
        assert len(maps) == 1 and maps[0]["title"] == "Ideas"
        # the only map of a mind map project can't be deleted
        assert c.delete(f"/api/mindmaps/{maps[0]['id']}", headers=h).status_code == 400
        # renaming the central topic renames the project, and vice versa
        root = next(n for n in c.get(f"/api/mindmaps/{maps[0]['id']}", headers=h).json()["nodes"] if n["parent_id"] is None)
        c.patch(f"/api/mind-nodes/{root['id']}", json={"text": "Big ideas"}, headers=h)
        assert c.get(f"/api/projects/{p['id']}", headers=h).json()["project"]["name"] == "Big ideas"
        c.patch(f"/api/projects/{p['id']}", json={"name": "Q3 ideas"}, headers=h)
        nodes = c.get(f"/api/mindmaps/{maps[0]['id']}", headers=h).json()["nodes"]
        assert next(n for n in nodes if n["parent_id"] is None)["text"] == "Q3 ideas"
        # add a board later: sections appear, the map stays and topics can become tasks
        conv = c.post(f"/api/projects/{p['id']}/convert", json={"template": "personal"}, headers=h).json()
        assert conv["kind"] == "board"
        board = c.get(f"/api/projects/{p['id']}", headers=h).json()
        assert [s["name"] for s in board["sections"]] == ["To Do", "Doing", "Done"]
        child = c.post(f"/api/mindmaps/{maps[0]['id']}/nodes", json={"parent_id": root["id"], "text": "Try it"}, headers=h).json()
        r = c.post(f"/api/mind-nodes/{child['id']}/to-task", json={"section_id": board["sections"][0]["id"]}, headers=h)
        assert r.status_code == 200
        assert c.get("/api/projects", headers=h).json()[0]["kind"] == "board"


def test_mindmap_display_settings_and_fold():
    with TestClient(app) as c:
        h, _ = login(c, "layout@m.io", "Layout")
        p = c.post("/api/projects", json={"name": "Layouts", "kind": "mindmap"}, headers=h).json()
        mm = c.get(f"/api/projects/{p['id']}/mindmaps", headers=h).json()[0]
        assert mm["settings"] == {}
        r = c.patch(f"/api/mindmaps/{mm['id']}", headers=h, json={"settings": {
            "layout": "radial", "lines": "elbow", "shape": "underline", "palette": "ocean", "spacing_x": 999,
            "font_scale": 1.2, "show_tasks": False, "layout_bogus": 1, "background": "hacker"}}).json()
        s = r["settings"]
        assert s["layout"] == "radial" and s["lines"] == "elbow" and s["spacing_x"] == 200 and s["show_tasks"] is False
        assert "layout_bogus" not in s and "background" not in s
        assert c.patch(f"/api/mindmaps/{mm['id']}", headers=h, json={"settings": {"layout": "org"}}).json()["settings"]["shape"] == "underline"
        assert c.patch(f"/api/mindmaps/{mm['id']}", headers=h, json={"settings": {"reset": True}}).json()["settings"] == {}
        # fold: root -> a -> b -> c
        root = c.get(f"/api/mindmaps/{mm['id']}", headers=h).json()["nodes"][0]
        a = c.post(f"/api/mindmaps/{mm['id']}/nodes", json={"parent_id": root["id"], "text": "a"}, headers=h).json()
        b = c.post(f"/api/mindmaps/{mm['id']}/nodes", json={"parent_id": a["id"], "text": "b"}, headers=h).json()
        c.post(f"/api/mindmaps/{mm['id']}/nodes", json={"parent_id": b["id"], "text": "c"}, headers=h)
        c.post(f"/api/mindmaps/{mm['id']}/fold", json={"level": 1}, headers=h)
        nodes = {n["text"]: n for n in c.get(f"/api/mindmaps/{mm['id']}", headers=h).json()["nodes"]}
        assert nodes["a"]["collapsed"] and not nodes["Layouts"]["collapsed"]
        c.post(f"/api/mindmaps/{mm['id']}/fold", json={"level": None}, headers=h)
        nodes = c.get(f"/api/mindmaps/{mm['id']}", headers=h).json()["nodes"]
        assert not any(n["collapsed"] for n in nodes)


def _follow(c, url):
    from urllib.parse import parse_qs, urlparse
    r = c.get(urlparse(url).path, follow_redirects=False)
    loc = r.headers["location"]
    return loc, parse_qs(urlparse(loc).fragment)


def test_activation_and_login_links():
    with TestClient(app) as c:
        c.post("/api/auth/otp/request", json={"email": "link@m.io"})
        link, is_new = LINKS["link@m.io"]
        assert is_new and "/api/auth/link/" in link
        loc, frag = _follow(c, link)
        assert loc.startswith("/auth/callback#") and frag["new"] == ["1"]
        h = {"Authorization": f"Bearer {frag['token'][0]}"}
        me = c.get("/api/me", headers=h).json()
        assert me["email"] == "link@m.io" and me["email_verified"] is True
        # single use, and the code from the same email is now dead too
        loc, _ = _follow(c, link)
        assert loc.startswith("/login#error=")
        assert c.post("/api/auth/otp/verify", json={"email": "link@m.io", "code": SENT["link@m.io"]}).status_code == 400


def test_invite_link_opens_project():
    with TestClient(app) as c:
        h, _ = login(c, "boss@m.io", "Boss")
        p = c.post("/api/projects", json={"name": "Invited"}, headers=h).json()
        c.post(f"/api/projects/{p['id']}/members", json={"email": "guest@m.io"}, headers=h)
        loc, frag = _follow(c, INVITES["guest@m.io"])
        assert frag["next"] == [f"/projects/{p['id']}"] and frag["new"] == ["1"]
        gh = {"Authorization": f"Bearer {frag['token'][0]}"}
        assert c.get(f"/api/projects/{p['id']}", headers=gh).status_code == 200


def test_google_signup_takes_name_photo_email(monkeypatch):
    import jwt as pyjwt
    from urllib.parse import parse_qs, urlparse
    from backend.app import config
    from backend.app.routers import auth as auth_router
    monkeypatch.setattr(config, "GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setattr(config, "GOOGLE_CLIENT_SECRET", "secret")
    claims = {"iss": "https://accounts.google.com", "aud": "cid.apps.googleusercontent.com", "sub": "g-123",
              "email": "Sara.Ali@Gmail.com", "email_verified": True, "name": "Sara Ali",
              "picture": "https://lh3.googleusercontent.com/a/photo123"}

    class FakeRes:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return {"id_token": pyjwt.encode(claims, "x", algorithm="HS256")}

    sent = {}
    monkeypatch.setattr(auth_router.httpx, "post", lambda url, **kw: (sent.update(kw["data"]), FakeRes())[1])
    with TestClient(app, base_url="http://localhost:8000") as c:
        r = c.get("/api/auth/google/start", follow_redirects=False)
        state = parse_qs(urlparse(r.headers["location"]).query)["state"][0]
        r = c.get(f"/api/auth/google/callback?code=abc&state={state}", follow_redirects=False)
        frag = parse_qs(urlparse(r.headers["location"]).fragment)
        assert sent["code_verifier"] and sent["code"] == "abc"
        me = c.get("/api/me", headers={"Authorization": f"Bearer {frag['token'][0]}"}).json()
        assert me["name"] == "Sara Ali" and me["email"] == "sara.ali@gmail.com"
        assert me["avatar_url"].endswith("photo123") and me["email_verified"] and me["google_linked"]


def skip_resend_wait(email):
    """Age earlier codes so the 30-second resend limit doesn't block the next request."""
    from backend.app import models as m
    from backend.app.db import SessionLocal
    with SessionLocal() as db:
        for otp in db.query(m.OtpCode).filter(m.OtpCode.email == email):
            otp.created_at = otp.created_at.replace(year=2000)
        db.commit()


def test_admin_panel(monkeypatch):
    from backend.app import config
    monkeypatch.setattr(config, "ADMIN_EMAILS", {"boss@x.io"})
    with TestClient(app) as c:
        hb, boss = login(c, "boss@x.io", "Boss")
        hu, user = login(c, "user@x.io", "User")
        assert boss["is_admin"] and not user["is_admin"]
        # regular users are kept out
        for path in ("/api/admin/overview", "/api/admin/users", "/api/admin/projects", "/api/admin/activity",
                     "/api/admin/system"):
            assert c.get(path, headers=hu).status_code == 403
            assert c.get(path, headers=hb).status_code == 200, path

        p = c.post("/api/projects", json={"name": "Side quest", "template": "kanban"}, headers=hu).json()
        ov = c.get("/api/admin/overview", headers=hb).json()
        assert ov["users"]["total"] >= 2 and ov["users"]["admins"] >= 1 and len(ov["signups"]) == 30
        users = c.get("/api/admin/users?q=user@x.io", headers=hb).json()
        assert [u["email"] for u in users] == ["user@x.io"] and users[0]["owned_projects"] == 1
        assert users[0]["last_login_at"] and users[0]["last_seen_at"]
        detail = c.get(f"/api/admin/users/{user['id']}", headers=hb).json()
        assert detail["project_list"][0]["role"] == "owner" and detail["activity"]
        assert any(x["id"] == p["id"] and not x["is_member"] for x in c.get("/api/admin/projects", headers=hb).json())

        # guard rails
        assert c.patch(f"/api/admin/users/{boss['id']}", json={"disabled": True}, headers=hb).status_code == 400
        assert c.patch(f"/api/admin/users/{boss['id']}", json={"is_admin": False}, headers=hb).status_code == 400

        # promote, then demote a regular user
        assert c.patch(f"/api/admin/users/{user['id']}", json={"is_admin": True}, headers=hb).json()["is_admin"]
        assert c.get("/api/admin/overview", headers=hu).status_code == 200
        c.patch(f"/api/admin/users/{user['id']}", json={"is_admin": False}, headers=hb)

        # sign out everywhere: the old token stops working, a new sign-in works
        assert c.post(f"/api/admin/users/{user['id']}/signout", headers=hb).status_code == 200
        assert c.get("/api/me", headers=hu).status_code == 401
        time.sleep(1.1)  # sessions are revoked by the second
        skip_resend_wait("user@x.io")
        hu, _ = login(c, "user@x.io")
        assert c.get("/api/me", headers=hu).status_code == 200

        # suspend: existing session dies and signing in is refused
        assert c.patch(f"/api/admin/users/{user['id']}", json={"disabled": True}, headers=hb).json()["disabled"]
        assert c.get("/api/me", headers=hu).status_code == 401
        skip_resend_wait("user@x.io")
        r = c.post("/api/auth/otp/request", json={"email": "user@x.io"})
        assert r.status_code == 403 and "suspended" in r.json()["detail"]
        c.patch(f"/api/admin/users/{user['id']}", json={"disabled": False}, headers=hb)

        # admin can delete any project
        assert c.delete(f"/api/admin/projects/{p['id']}", headers=hb).status_code == 200
        assert c.get(f"/api/projects/{p['id']}", headers=hb).status_code == 404


def test_admin_password_sign_in():
    from backend.app.manage import create_admin
    from backend.app.passwords import hash_password, verify_password
    from backend.app.routers import auth as auth_router

    stored = hash_password("Correct-horse-9")
    assert stored.startswith("scrypt$") and "Correct-horse-9" not in stored
    assert verify_password("Correct-horse-9", stored) and not verify_password("wrong", stored)

    auth_router._fails.clear()
    with TestClient(app) as c:
        admin = create_admin("rootadmin", "Sup3r-secret!", name="Root Admin")
        assert admin.email == "rootadmin@admin.invalid"

        # wrong password, unknown user: same generic answer
        r = c.post("/api/auth/admin/login", json={"username": "rootadmin", "password": "nope"})
        assert r.status_code == 401 and "Wrong username or password" in r.json()["detail"]
        assert c.post("/api/auth/admin/login", json={"username": "ghost", "password": "x"}).status_code == 401

        r = c.post("/api/auth/admin/login", json={"username": "RootAdmin", "password": "Sup3r-secret!"})
        assert r.status_code == 200, r.text
        h = {"Authorization": f"Bearer {r.json()['token']}"}
        me = c.get("/api/me", headers=h).json()
        assert me["is_admin"] and me["has_password"] and me["email_placeholder"] and me["username"] == "rootadmin"
        assert c.get("/api/admin/overview", headers=h).status_code == 200

        # the placeholder email can't be used for email codes, and nothing is emailed to it
        assert c.post("/api/auth/otp/request", json={"email": "rootadmin@admin.invalid"}).status_code == 422

        # regular accounts have no password sign-in
        login(c, "plain@x.io")
        assert c.post("/api/auth/admin/login", json={"username": "plain@x.io", "password": "anything12"}).status_code == 401

        # protected: can't be suspended or demoted from the panel, even by another admin
        r = c.patch(f"/api/admin/users/{admin.id}", json={"disabled": True}, headers=h)
        assert r.status_code == 400

        # change password: weak and wrong-current are refused, success signs out other sessions
        other = c.post("/api/auth/admin/login", json={"username": "rootadmin", "password": "Sup3r-secret!"}).json()["token"]
        assert c.post("/api/me/password", json={"current": "bad", "new": "N3w-password!"}, headers=h).status_code == 400
        assert c.post("/api/me/password", json={"current": "Sup3r-secret!", "new": "short"}, headers=h).status_code == 422
        time.sleep(1.1)
        r = c.post("/api/me/password", json={"current": "Sup3r-secret!", "new": "N3w-password!"}, headers=h)
        assert r.status_code == 200
        assert c.get("/api/me", headers={"Authorization": f"Bearer {r.json()['token']}"}).status_code == 200
        assert c.get("/api/me", headers={"Authorization": f"Bearer {other}"}).status_code == 401
        assert c.post("/api/auth/admin/login", json={"username": "rootadmin", "password": "Sup3r-secret!"}).status_code == 401

        # lockout after 5 failures, even with the right password
        auth_router._fails.clear()
        for _ in range(5):
            c.post("/api/auth/admin/login", json={"username": "rootadmin", "password": "wrong-one"})
        r = c.post("/api/auth/admin/login", json={"username": "rootadmin", "password": "N3w-password!"})
        assert r.status_code == 429
        auth_router._fails.clear()


def test_project_categories_and_integrations(monkeypatch):
    from backend.app.routers import integrations as integ

    repo = {"full_name": "acme/rocket", "html_url": "https://github.com/acme/rocket", "private": False,
            "default_branch": "main", "stargazers_count": 7, "forks_count": 2, "language": "Python"}
    issues = [
        {"number": 12, "title": "Crash on start", "html_url": "https://github.com/acme/rocket/issues/12", "state": "open",
         "user": {"login": "sam"}, "labels": [{"name": "bug", "color": "d73a4a"}], "body": "Steps to reproduce…"},
        {"number": 13, "title": "Dark mode", "html_url": "https://github.com/acme/rocket/issues/13", "state": "open",
         "user": {"login": "kim"}, "labels": [{"name": "enhancement"}], "body": ""},
        {"number": 14, "title": "A pull request", "html_url": "https://github.com/acme/rocket/pull/14",
         "pull_request": {}, "labels": []},
    ]
    calls = []

    def fake_github(path, token=None, params=None):
        calls.append((path, token))
        if path == "/repos/acme/missing":
            raise integ.GithubError(404, "Repository not found.")
        if path == "/repos/acme/rocket":
            return repo
        if path.endswith("/pulls"):
            return [{"number": 20, "title": "Add login", "html_url": "u", "user": {"login": "sam"}, "draft": False,
                     "head": {"ref": "login"}, "base": {"ref": "main"}}]
        if path.endswith("/commits"):
            return [{"sha": "abcdef1234", "commit": {"message": "Fix crash\n\nlong text", "author": {"name": "Sam", "date": "2026-11-20T10:00:00Z"}},
                     "html_url": "c", "author": {"login": "sam"}}]
        if path.endswith("/issues"):
            if (params or {}).get("state") == "closed":
                return [{"number": 12, "title": "Crash on start"}]
            return issues
        raise AssertionError(path)

    sent = []
    monkeypatch.setattr(integ, "github_request", fake_github)
    monkeypatch.setattr(integ, "post_webhook", lambda url, payload: sent.append((url, payload)))

    with TestClient(app) as c:
        h, _ = login(c, "dev@x.io", "Dev")
        hv, _ = login(c, "viewer@x.io", "Vee")

        # category picks a matching board and tags
        sw = c.post("/api/projects", json={"name": "Rocket", "template": "software", "category": "software"}, headers=h).json()
        hw = c.post("/api/projects", json={"name": "Drone", "template": "hardware", "category": "hardware"}, headers=h).json()
        gen = c.post("/api/projects", json={"name": "Errands"}, headers=h).json()
        assert (sw["category"], hw["category"], gen["category"]) == ("software", "hardware", "general")
        board = c.get(f"/api/projects/{sw['id']}", headers=h).json()
        assert [s["name"] for s in board["sections"]][3] == "Code Review"
        assert {t["name"] for t in board["tags"]} >= {"Bug", "Feature", "Tech debt"}
        hw_board = c.get(f"/api/projects/{hw['id']}", headers=h).json()
        assert "Prototype" in [s["name"] for s in hw_board["sections"]] and "Firmware" in {t["name"] for t in hw_board["tags"]}
        assert c.post("/api/projects", json={"name": "X", "category": "space"}, headers=h).status_code == 422

        # integrations only for software projects
        assert c.get(f"/api/projects/{gen['id']}/integrations", headers=h).status_code == 409
        assert c.patch(f"/api/projects/{gen['id']}", json={"category": "software"}, headers=h).json()["category"] == "software"
        assert c.get(f"/api/projects/{gen['id']}/integrations", headers=h).status_code == 200

        # connect GitHub (token stored encrypted, never returned)
        base = f"/api/projects/{sw['id']}"
        assert c.post(f"{base}/integrations/github", json={"repo": "acme/missing"}, headers=h).status_code == 404
        assert c.post(f"{base}/integrations/github", json={"repo": "not a repo"}, headers=h).status_code == 422
        r = c.post(f"{base}/integrations/github", json={"repo": "https://github.com/acme/rocket.git", "token": "ghp_secret123"}, headers=h)
        assert r.status_code == 200 and r.json()["repo"] == "acme/rocket" and r.json()["has_token"]
        assert "ghp_secret123" not in r.text and calls[-1] == ("/repos/acme/rocket", "ghp_secret123")
        from backend.app import models as m
        from backend.app.db import SessionLocal
        with SessionLocal() as db:
            stored = db.query(m.Integration).filter_by(project_id=sw["id"], provider="github").one().secret
            assert stored and "ghp_secret123" not in stored

        # only admins connect; other members can't see it at all until invited
        c.post(f"{base}/members", json={"email": "viewer@x.io", "role": "viewer"}, headers=h)
        assert c.post(f"{base}/integrations/github", json={"repo": "acme/rocket"}, headers=hv).status_code == 403
        listed = c.get(f"{base}/integrations", headers=hv).json()
        assert not listed["can_manage"] and "ghp_secret123" not in str(listed)

        ov = c.get(f"{base}/github", headers=h).json()
        assert ov["repo"]["stars"] == 7 and ov["pulls"][0]["number"] == 20 and ov["commits"][0]["message"] == "Fix crash"
        assert [i["number"] for i in ov["issues"]] == [12, 13]  # pull requests aren't issues

        # import issues as tasks, labels become tags, no duplicates
        r = c.post(f"{base}/github/import", json={"numbers": [12, 13, 12]}, headers=h).json()
        assert r["imported"] == 2
        t12 = next(t for t in r["tasks"] if t["title"] == "Crash on start")
        assert t12["external"] == {"provider": "github", "label": "acme/rocket#12", "url": "https://github.com/acme/rocket/issues/12"}
        tag_names = {t["id"]: t["name"] for t in c.get(f"/api/projects/{sw['id']}", headers=h).json()["tags"]}
        assert [tag_names[i] for i in t12["tag_ids"]] == ["Bug"]
        assert c.post(f"{base}/github/import", json={"numbers": [12]}, headers=h).json()["imported"] == 0
        assert c.get(f"{base}/github", headers=h).json()["issues"][0]["task"]["number"] == t12["number"]

        # closed issue on GitHub completes its task
        r = c.post(f"{base}/github/sync", headers=h).json()
        assert r == {"checked": 2, "completed": 1}
        assert c.get(f"/api/tasks/{t12['id']}", headers=h).json()["status"] == "completed"

        # Slack: URL validated, events chosen, messages sent after changes
        assert c.post(f"{base}/integrations/slack", json={"url": "https://evil.example.com/hook"}, headers=h).status_code == 422
        r = c.post(f"{base}/integrations/slack", json={"url": "https://hooks.slack.com/services/T0/B0/abcd1234",
                                                     "events": ["task.created", "nonsense"]}, headers=h).json()
        assert r["events"] == ["task.created"] and r["hint"].endswith("1234") and "hooks.slack.com/services/T0" not in r["hint"]
        sent.clear()
        board = c.get(f"/api/projects/{sw['id']}", headers=h).json()
        c.post(f"/api/projects/{sw['id']}/tasks", json={"title": "Ship <it> & celebrate", "section_id": board["sections"][0]["id"]}, headers=h)
        for _ in range(50):
            if sent:
                break
            time.sleep(0.05)
        assert sent and sent[0][0] == "https://hooks.slack.com/services/T0/B0/abcd1234"
        assert "Ship &lt;it&gt; &amp; celebrate" in sent[0][1]["text"] and "*Rocket*" in sent[0][1]["text"]

        # Discord test message, then disconnect
        d = c.post(f"{base}/integrations/discord", json={"url": "https://discord.com/api/webhooks/123/tok-en"}, headers=h).json()
        sent.clear()
        assert c.post(f"{base}/integrations/{d['id']}/test", headers=h).status_code == 200
        assert sent[0][1]["allowed_mentions"] == {"parse": []}
        assert c.delete(f"{base}/integrations/{d['id']}", headers=h).status_code == 200
        assert {i["provider"] for i in c.get(f"{base}/integrations", headers=h).json()["connected"]} == {"github", "slack"}


def test_github_app_optional(monkeypatch):
    import hashlib
    import hmac
    import json as _json

    import jwt as pyjwt
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    from backend.app import config, github_app
    from backend.app.routers import integrations as integ

    # the app's JWT is a real RS256 token signed with its private key
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
    monkeypatch.setattr(config, "GITHUB_APP_ID", "")
    assert not github_app.configured()
    monkeypatch.setattr(config, "GITHUB_APP_ID", "4242")
    monkeypatch.setattr(config, "GITHUB_APP_PRIVATE_KEY", pem)
    monkeypatch.setattr(config, "GITHUB_APP_SLUG", "tek-plane-app")
    claims = pyjwt.decode(github_app.app_jwt(), key.public_key(), algorithms=["RS256"])
    assert claims["iss"] == "4242" and claims["exp"] - claims["iat"] <= 600

    installed = {"acme/rocket": 77, "acme/docs": 77}
    monkeypatch.setattr(github_app, "find_installation", lambda repo: installed.get(repo))
    monkeypatch.setattr(github_app, "installation_token", lambda inst: f"ghs_inst_{inst}")
    seen_tokens = []
    # what each person's GitHub account can reach through the app, with their permission there
    user_repos = {"acme/rocket": {"pull": True, "triage": True, "push": True}, "acme/docs": {"pull": True},
                  "acme/other": {"pull": True, "admin": True}}

    def fake_github(path, token=None, params=None):
        seen_tokens.append(token)
        if path == "/user":
            return {"id": 9, "login": "octo", "name": "Octo Cat", "avatar_url": "https://avatars.example/octo"}
        if path == "/user/installations":
            if token == "ghu_revoked":
                raise integ.GithubError(400, "rejected", 401)
            return {"installations": [{"id": 77, "account": {"login": "acme", "type": "Organization"},
                                       "repository_selection": "selected", "html_url": "https://github.com/settings/installations/77"}]}
        if path == "/user/installations/77/repositories":
            return {"repositories": [{"full_name": n, "private": n == "acme/rocket", "pushed_at": "2026-11-2%dT00:00:00Z" % i,
                                      "permissions": perms} for i, (n, perms) in enumerate(user_repos.items())]}
        if path.startswith("/repos/acme/"):
            name = path[7:]
            if token and token.startswith("ghu_"):  # the person's own token
                if name not in user_repos:
                    raise integ.GithubError(404, "Repository not found.")
                return {"full_name": name, "permissions": user_repos[name]}
            return {"full_name": name, "html_url": f"https://github.com/{name}", "private": True, "default_branch": "main"}
        raise AssertionError(path)

    exchanged, refreshed, revoked = [], [], []
    monkeypatch.setattr(github_app, "exchange_code", lambda code, redirect_uri, verifier=None: exchanged.append(
        (code, redirect_uri, verifier)) or {"access_token": "ghu_user", "expires_in": 28800, "refresh_token": "ghr_1",
                                             "refresh_token_expires_in": 15897600})
    monkeypatch.setattr(github_app, "refresh_user_token", lambda rt: refreshed.append(rt) or {
        "access_token": "ghu_fresh", "expires_in": 28800, "refresh_token": "ghr_2", "refresh_token_expires_in": 15897600})
    monkeypatch.setattr(github_app, "revoke_user_token", lambda t: revoked.append(t))

    writes = []
    monkeypatch.setattr(integ, "github_request", fake_github)
    monkeypatch.setattr(integ, "github_write", lambda method, path, token, body: writes.append((method, path, token, body)) or {})
    monkeypatch.setattr(config, "GITHUB_WEBHOOK_SECRET", "whsec_test")

    with TestClient(app) as c:
        h, _ = login(c, "app@x.io", "App Dev")
        sw = c.post("/api/projects", json={"name": "Rocket", "template": "software", "category": "software"}, headers=h).json()
        base = f"/api/projects/{sw['id']}"
        info = c.get(f"{base}/integrations", headers=h).json()["github_app"]
        assert info["configured"] and info["install_url"] == "https://github.com/apps/tek-plane-app/installations/new"
        assert info["webhook_url"].endswith("/api/integrations/github/webhook") and info["webhook_ready"]

        # without the app's client ID/secret nobody can link through the app (no way to check their access)
        assert not info["oauth_ready"]
        r = c.post(f"{base}/integrations/github", json={"repo": "acme/rocket", "method": "app"}, headers=h)
        assert r.status_code == 409 and "GITHUB_APP_CLIENT_SECRET" in r.json()["detail"]
        monkeypatch.setattr(config, "GITHUB_APP_CLIENT_ID", "Iv_test")
        monkeypatch.setattr(config, "GITHUB_APP_CLIENT_SECRET", "cs_test")
        info = c.get(f"{base}/integrations", headers=h).json()["github_app"]
        assert info["oauth_ready"] and info["account"] is None

        # typing a repository name isn't enough: the person must connect their own GitHub account first
        r = c.post(f"{base}/integrations/github", json={"repo": "acme/rocket"}, headers=h)
        assert r.status_code == 409 and "Connect your GitHub account" in r.json()["detail"]
        assert c.get("/api/integrations/github/repos", headers=h).status_code == 409

        # authorize: explicit redirect_uri, state + PKCE, and a cookie that binds the flow to this browser
        from urllib.parse import parse_qs, urlsplit
        url = c.post("/api/integrations/github/authorize", json={"project_id": sw["id"]}, headers=h).json()["url"]
        q = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        assert url.startswith("https://github.com/login/oauth/authorize?") and q["client_id"] == "Iv_test"
        assert q["redirect_uri"].endswith("/api/integrations/github/callback") and q["code_challenge_method"] == "S256"
        cb = "/api/integrations/github/callback"
        bad = c.get(cb, params={"code": "abc", "state": "forged"}, follow_redirects=False)
        assert bad.status_code == 302 and "github_error=" in bad.headers["location"] and not exchanged
        # a failed callback ends that attempt; start again
        url = c.post("/api/integrations/github/authorize", json={"project_id": sw["id"]}, headers=h).json()["url"]
        q = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
        ok = c.get(cb, params={"code": "abc", "state": q["state"]}, follow_redirects=False)
        assert ok.headers["location"] == f"/projects/{sw['id']}/integrations#github=connected"
        assert exchanged[0][0] == "abc" and exchanged[0][2]  # PKCE verifier sent with the code
        # the cookie is single-use: replaying the callback doesn't work
        again = c.get(cb, params={"code": "abc", "state": q["state"]}, follow_redirects=False)
        assert "github_error=" in again.headers["location"] and len(exchanged) == 1
        info = c.get(f"{base}/integrations", headers=h).json()["github_app"]
        assert info["account"]["login"] == "octo"

        # the picker lists what both the person and the app can reach; read-only ones can't be linked
        listed = c.get("/api/integrations/github/repos", headers=h).json()
        repos = {r["full_name"]: r for g in listed["installations"] for r in g["repos"]}
        assert repos["acme/rocket"]["can_link"] and not repos["acme/docs"]["can_link"]
        r = c.post(f"{base}/integrations/github", json={"repo": "acme/docs"}, headers=h)
        assert r.status_code == 403 and "triage" in r.json()["detail"]
        r = c.post(f"{base}/integrations/github", json={"repo": "acme/secret"}, headers=h)
        assert r.status_code == 404 and "@octo" in r.json()["detail"]
        # not installed on that repository yet
        r = c.post(f"{base}/integrations/github", json={"repo": "acme/other"}, headers=h)
        assert r.status_code == 409 and "isn't installed" in r.json()["detail"]
        # someone else in the project, without a GitHub account, can't link through the app
        h2, _ = login(c, "app-peer@x.io", "Peer")
        assert c.post(f"{base}/integrations/github", json={"repo": "acme/rocket"}, headers=h2).status_code in (403, 404)
        # the GitHub App is the default when set up; installation token is used, nothing is stored
        r = c.post(f"{base}/integrations/github", json={"repo": "acme/rocket"}, headers=h).json()
        assert r["auth"] == "app" and not r["has_token"] and r["close_issues"] and seen_tokens[-1] == "ghs_inst_77"
        assert r["linked_by"] == "octo"

        # an expiring user token is refreshed (refresh tokens rotate)
        from backend.app import models as m
        from backend.app.db import SessionLocal
        with SessionLocal() as db:
            acc = db.query(m.GithubAccount).one()
            acc.expires_at = m.utcnow()
            db.commit()
        assert c.get("/api/integrations/github/repos", headers=h).status_code == 200
        assert refreshed == ["ghr_1"] and "ghu_fresh" in seen_tokens
        # a token revoked on GitHub disconnects the account
        from backend.app.secretbox import seal
        with SessionLocal() as db:
            acc = db.query(m.GithubAccount).one()
            acc.access_token = seal("ghu_revoked")
            db.commit()
        r = c.get("/api/integrations/github/repos", headers=h)
        assert r.status_code == 409 and "Connect your GitHub account again" in r.json()["detail"]
        assert c.get(f"{base}/integrations", headers=h).json()["github_app"]["account"] is None
        # connect again, then disconnect: the token is revoked on GitHub; the linked repository keeps working
        url = c.post("/api/integrations/github/authorize", json={"project_id": sw["id"]}, headers=h).json()["url"]
        state = parse_qs(urlsplit(url).query)["state"][0]
        c.get(cb, params={"code": "def", "state": state}, follow_redirects=False)
        assert c.delete("/api/integrations/github/account", headers=h).json()["ok"] and revoked == ["ghu_user"]
        assert c.get(f"{base}/integrations", headers=h).json()["connected"][0]["auth"] == "app"
        url = c.post("/api/integrations/github/authorize", json={"project_id": sw["id"]}, headers=h).json()["url"]
        c.get(cb, params={"code": "ghi", "state": parse_qs(urlsplit(url).query)["state"][0]}, follow_redirects=False)
        # …but it's optional: a personal token (or none) still works
        r2 = c.post(f"{base}/integrations/github", json={"repo": "acme/rocket", "method": "token", "token": "ghp_x"}, headers=h).json()
        assert r2["auth"] == "token" and r2["has_token"]
        r = c.post(f"{base}/integrations/github", json={"repo": "acme/rocket", "method": "app"}, headers=h).json()
        assert r["auth"] == "app"

        # a task linked to issue #5: completing it closes the issue, reopening reopens it
        board = c.get(f"/api/projects/{sw['id']}", headers=h).json()
        monkeypatch.setattr(integ, "github_request", lambda path, token=None, params=None: {
            "number": 5, "title": "Login fails", "html_url": "https://github.com/acme/rocket/issues/5", "state": "open",
            "labels": [], "body": ""})
        task = c.post(f"{base}/github/import", json={"numbers": [5]}, headers=h).json()["tasks"][0]

        def wait_for(n):
            for _ in range(60):
                if len(writes) >= n:
                    return
                time.sleep(0.05)

        c.patch(f"/api/tasks/{task['id']}", json={"status": "completed"}, headers=h)
        wait_for(1)
        assert writes[0] == ("PATCH", "/repos/acme/rocket/issues/5", "ghs_inst_77", {"state": "closed", "state_reason": "completed"})
        c.patch(f"/api/tasks/{task['id']}", json={"status": "open"}, headers=h)
        wait_for(2)
        assert writes[1][3] == {"state": "open"}

        # switching write-back off stops it
        c.patch(f"{base}/integrations/{r['id']}", json={"close_issues": False, "auto_import": True}, headers=h)
        c.patch(f"/api/tasks/{task['id']}", json={"status": "completed"}, headers=h)
        time.sleep(0.4)
        assert len(writes) == 2
        c.patch(f"/api/tasks/{task['id']}", json={"status": "open"}, headers=h)

        # webhook: signature checked; closing on GitHub completes the task; new issues auto-import
        def send(event, payload, secret="whsec_test"):
            raw = _json.dumps(payload).encode()
            sig = "sha256=" + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
            return c.post("/api/integrations/github/webhook", content=raw,
                          headers={"x-github-event": event, "x-hub-signature-256": sig, "content-type": "application/json"})

        repo = {"full_name": "acme/rocket"}
        assert send("issues", {"action": "closed", "issue": {"number": 5}, "repository": repo}, secret="wrong").status_code == 401
        assert send("ping", {}).json()["ok"]
        assert send("issues", {"action": "closed", "issue": {"number": 5}, "repository": repo}).json()["changed"] == 1
        t = c.get(f"/api/tasks/{task['id']}", headers=h).json()
        assert t["status"] == "completed"
        time.sleep(0.3)
        assert len(writes) == 2  # no echo back to GitHub
        acts = c.get(f"/api/projects/{sw['id']}/activity", headers=h).json()
        assert any(a["action"] == "task.completed" and a["data"].get("via") == "GitHub" for a in acts)
        new_issue = {"number": 9, "title": "Add 2FA", "html_url": "https://github.com/acme/rocket/issues/9",
                     "labels": [{"name": "enhancement"}], "body": "Please"}
        assert send("issues", {"action": "opened", "issue": new_issue, "repository": repo}).json()["changed"] == 1
        titles = [x["title"] for x in c.get(f"/api/projects/{sw['id']}", headers=h).json()["tasks"]]
        assert "Add 2FA" in titles
