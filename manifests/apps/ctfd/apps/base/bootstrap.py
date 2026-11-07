"""Run CTFd's setup once, before the web server can accept public traffic."""
import os

from CTFd import create_app
from CTFd.models import Admins
from CTFd.utils import get_config, set_config

app = create_app()
assert app.config["SESSION_COOKIE_SECURE"] is True
with app.app_context():
    if get_config("setup"):
        # Rename only the stock placeholder title; preserve organizer names.
        if get_config("ctf_name") == "CTFd":
            set_config("ctf_name", os.environ["CTFD_NAME"])
        print("CTFd is already initialized; preserving accounts and settings.")
    else:
        with app.test_client() as client:
            base_url = "https://localhost"
            response = client.get("/setup", base_url=base_url)
            assert response.status_code == 200, "Could not load CTFd setup"
            with client.session_transaction(base_url=base_url) as session:
                nonce = session["nonce"]
            response = client.post(
                "/setup",
                base_url=base_url,
                data={
                    "nonce": nonce,
                    "ctf_name": os.environ["CTFD_NAME"],
                    "name": os.environ["CTFD_ADMIN_NAME"],
                    "email": os.environ["CTFD_ADMIN_EMAIL"],
                    "password": os.environ["CTFD_ADMIN_PASSWORD"],
                    "user_mode": "teams",
                    "challenge_visibility": "private",
                    "registration_visibility": "public",
                    "score_visibility": "public",
                    "account_visibility": "public",
                },
            )
            assert response.status_code == 302, "CTFd setup failed"
        assert get_config("setup"), "CTFd setup was not saved"
        assert Admins.query.filter_by(name=os.environ["CTFD_ADMIN_NAME"]).first()
        print("CTFd initialized with the configured admin account.")
