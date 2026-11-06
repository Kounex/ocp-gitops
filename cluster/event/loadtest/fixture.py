"""Synthetic fixture: restricted to the disposable event-capacity database."""
import hashlib
import hmac
import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy.engine.url import make_url
from CTFd import create_app
from CTFd.cache import cache
from CTFd.models import Challenges, Flags, Solves, Teams, Users, db
from CTFd.utils import set_config
from CTFd.utils.crypto import hash_password
from CTFd.plugins.open_tech_quest import demo
from CTFd.plugins.open_tech_quest.models import (
    QuestAudit, QuestEvent, QuestOnboarding, QuestReadiness, QuestRoom,
    QuestStart, QuestStep, QuestTeamName,
)

assert os.environ.get("QUEST_LOADTEST") == "isolated-event-capacity-test"
assert make_url(os.environ["DATABASE_URL"]).database == "ctfd_loadtest_test"
password = hmac.new(os.environ["SECRET_KEY"].encode(), b"loadtest-participants-v1", hashlib.sha256).hexdigest()
app = create_app()
with app.app_context():
    marker = QuestAudit.query.filter_by(action="loadtest.fixture").first()
    at = datetime.utcnow() - timedelta(hours=1)
    if marker is None:
        assert Users.query.count() == 1 and Users.query.get(1).type == "admin"
        assert Teams.query.count() == Challenges.query.count() == Solves.query.count() == QuestStart.query.count() == 0
        event = QuestEvent.query.get(1)
        batch = demo.load(event)
        batch.active, batch.active_slot, batch.removed_at = False, None, at
        event.status, event.start_at = "live", at
        for key, value in (
            ("setup", True), ("ctf_name", "DISPOSABLE Open Tech Quest load test"),
            ("user_mode", "teams"), ("challenge_visibility", "public"),
            ("account_visibility", "public"), ("verify_emails", False),
            ("registration_visibility", "public"), ("paused", False),
            ("start", int(at.timestamp())), ("end", None),
        ):
            set_config(key, value)
        state = QuestOnboarding.query.get(1)
        state.phase, state.team_size, state.grandfathered = "finalized", 8, True
        state.finalized_at, state.attendance_open = at, False
        hashed = hash_password(password)
        rooms = QuestRoom.query.order_by(QuestRoom.position).all()
        steps = {r.id: QuestStep.query.filter_by(room_id=r.id).order_by(QuestStep.position).all() for r in rooms}
        for index in range(50):
            team = Teams(name=f"Synthetic team {index + 1:02}")
            db.session.add(team)
            db.session.flush()
            rows = [{
                "id": 2 + index * 8 + member, "name": f"load-user-{index * 8 + member + 1:03}",
                "email": f"load-{index * 8 + member + 1:03}@example.test",
                "password": hashed, "type": "user", "verified": True,
                "banned": False, "hidden": False, "team_id": team.id,
            } for member in range(8)]
            db.session.execute(Users.__table__.insert(), rows)
            team.captain_id = rows[0]["id"]
            db.session.add(QuestTeamName(team_id=team.id, name_locked=True, auto_named=True))
            for row in rows:
                db.session.add(QuestReadiness(user_id=row["id"], ready_at=at))
            for rindex, room in enumerate(rooms):
                start = at + timedelta(minutes=1 + rindex)
                db.session.add(QuestStart(team_id=team.id, room_id=room.id, started_at=start))
                for step in steps[room.id][:(index + rindex * 2) % 5]:
                    db.session.add(Solves(challenge_id=step.challenge_id, user_id=rows[0]["id"],
                        team_id=team.id, date=start + timedelta(seconds=30 * (step.position + 1))))
        db.session.add(QuestAudit(actor_id=1, action="loadtest.fixture", detail={"fixture": "event-capacity-v1"}))
        db.session.commit()
        cache.clear()
    else:
        assert marker.detail == {"fixture": "event-capacity-v1"}
        assert Users.query.filter_by(type="user").count() >= 400
        assert Teams.query.count() == 50 and Challenges.query.count() == 25
        rooms = QuestRoom.query.order_by(QuestRoom.position).all()
        steps = {r.id: QuestStep.query.filter_by(room_id=r.id).order_by(QuestStep.position).all() for r in rooms}
    if "--late" in sys.argv:
        # Add history without clearing native Redis sessions or resetting progress.
        for team in Teams.query.all():
            for room in rooms:
                start = QuestStart.query.filter_by(team_id=team.id, room_id=room.id).one()
                for step in steps[room.id][:4]:
                    if not Solves.query.filter_by(team_id=team.id, challenge_id=step.challenge_id).first():
                        db.session.add(Solves(challenge_id=step.challenge_id, user_id=team.captain_id,
                            team_id=team.id, date=start.started_at + timedelta(seconds=30 * (step.position + 1))))
        db.session.commit()
        from CTFd.cache import clear_challenges, clear_standings
        clear_challenges()
        clear_standings()
    mapping = [{"slug": r.slug, "id": r.id, "steps": [
        {"id": s.challenge_id, "flag": Flags.query.filter_by(challenge_id=s.challenge_id).one().content}
        for s in steps[r.id]
    ]} for r in rooms]
    runtime = Path("/run/quest-loadtest/participants.json")
    runtime.touch(mode=0o600, exist_ok=True)
    runtime.write_text(json.dumps({"password": password, "challenges": mapping}))
    runtime.chmod(0o600)
    print(json.dumps({"fixture": "event-capacity-v1", "participants": 400,
        "teams": Teams.query.count(), "challenges": Challenges.query.count(),
        "solves": Solves.query.count(), "room_starts": QuestStart.query.count()}))
