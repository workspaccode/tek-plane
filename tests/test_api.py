import os
import tempfile

os.environ["TEKPLANE_DATA_DIR"] = tempfile.mkdtemp()

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from backend.app.main import app  # noqa: E402


SENT = {}


@pytest.fixture(autouse=True)
def capture_codes(monkeypatch):
    from backend.app import mailer
    monkeypatch.setattr(mailer, "send_login_code", lambda to, code: SENT.__setitem__(to, code))
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


def test_otp_rules():
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
    with TestClient(app) as c:
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
