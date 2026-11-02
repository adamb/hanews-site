#!/usr/bin/env python3
"""One-time OAuth for the Google Search Console API (read-only).

Grants exactly one scope -- https://www.googleapis.com/auth/webmasters.readonly --
and stores the refresh token OUTSIDE the repo, at:

    ~/.hermes/profiles/hanews/gsc-token.json   (mode 0600)

The token file is never committed: `gsc-token*.json` is git-ignored by name in
hanews-site and the path lives outside the working tree anyway.

Typical use (Adam's hand-off):

    # 1. start the local callback listener on the VPS (writes token on success)
    python3 scripts/gsc_oauth.py --serve --hours 72

    # 2. on your laptop, forward the callback port
    ssh -N -L 3000:127.0.0.1:3000 roux

    # 3. open the URL the listener printed, sign in as beguelin@gmail.com,
    #    click Allow. The listener catches the redirect and finishes.

Other modes:

    --url                 print a fresh authorization URL and exit
    --status              show whether a refresh token is stored and what scope
    --exchange CODE       exchange a pasted authorization code (manual fallback)

Nothing here needs a password and nothing is sent anywhere but Google.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
IDENTITY_SCOPE = "openid email"
AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
TOKENINFO = "https://oauth2.googleapis.com/tokeninfo"

PROFILE_DIR = os.path.expanduser("~/.hermes/profiles/hanews")
TOKEN_PATH = os.environ.get(
    "GSC_TOKEN_PATH", os.path.join(PROFILE_DIR, "gsc-token.json")
)
# The installed-app client used by the google-workspace MCP on this box.
# Override with --client if Adam creates a dedicated GCP project/client.
DEFAULT_CLIENT_CANDIDATES = [
    os.path.expanduser("~/.google-mcp/credentials.json"),
    os.path.join(PROFILE_DIR, "gsc-client-secret.json"),
]
REDIRECT_URI = os.environ.get("GSC_REDIRECT_URI", "http://localhost:3000")


def load_client(path: str | None) -> dict:
    candidates = [path] if path else DEFAULT_CLIENT_CANDIDATES
    for c in candidates:
        if c and os.path.exists(c):
            raw = json.load(open(c))
            return raw.get("installed") or raw.get("web") or raw
    raise SystemExit(
        "no OAuth client JSON found; pass --client /path/to/client_secret.json "
        "(Desktop app client from Google Cloud Console)"
    )


def pkce_pair() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .rstrip(b"=")
        .decode()
    )
    return verifier, challenge


def auth_url(client: dict, challenge: str, state: str) -> str:
    params = {
        "client_id": client["client_id"],
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": f"{SCOPE} {IDENTITY_SCOPE}",
        "access_type": "offline",          # we need a refresh token
        "prompt": "consent",               # force refresh_token even on re-consent
        "include_granted_scopes": "false",
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    return AUTH_ENDPOINT + "?" + urllib.parse.urlencode(params)


def exchange(client: dict, code: str, verifier: str) -> dict:
    body = urllib.parse.urlencode(
        {
            "client_id": client["client_id"],
            "client_secret": client["client_secret"],
            "code": code,
            "code_verifier": verifier,
            "grant_type": "authorization_code",
            "redirect_uri": REDIRECT_URI,
        }
    ).encode()
    req = urllib.request.Request(
        TOKEN_ENDPOINT, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"token exchange failed: HTTP {e.code} {e.read().decode()[:400]}")


def save_token(client: dict, tok: dict) -> str:
    os.makedirs(os.path.dirname(TOKEN_PATH), exist_ok=True)
    payload = {
        "type": "authorized_user",
        "client_id": client["client_id"],
        "client_secret": client["client_secret"],
        "refresh_token": tok["refresh_token"],
        "scope": tok.get("scope", SCOPE),
        "obtained_at": datetime.now(timezone.utc).isoformat(),
    }
    fd = os.open(TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(payload, f, indent=1)
    os.chmod(TOKEN_PATH, 0o600)
    return TOKEN_PATH


def identity(access_token: str) -> str:
    try:
        with urllib.request.urlopen(
            TOKENINFO + "?access_token=" + urllib.parse.quote(access_token), timeout=20
        ) as r:
            return json.load(r).get("email") or "?"
    except Exception:
        return "?"


class _Handler(http.server.BaseHTTPRequestHandler):
    result: dict = {}
    expected_state: str = ""

    def log_message(self, format, *args):  # noqa: A002 - match base signature
        # silence default request logging
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        if parsed.path != "/":
            self.send_response(404)
            self.end_headers()
            return
        if "code" not in qs:
            self._page(400, "Authorization failed", qs.get("error", ["unknown"])[0])
            _Handler.result = {"error": qs.get("error", ["unknown"])[0]}
            return
        if qs.get("state", [""])[0] != _Handler.expected_state:
            # A stray or replayed request must not end the wait: ignore it and
            # keep listening for the genuine redirect.
            self._page(400, "State mismatch", "This link did not come from the "
                                              "listener that issued it. Ignored.")
            return
        self._page(200, "Authorized", "You can close this tab. The report script will now work.")
        _Handler.result = {"code": qs["code"][0], "state": qs["state"][0]}

    def _page(self, code: int, title: str, msg: str):
        html = (
            f"<html><body style='font-family:system-ui;padding:3rem;max-width:40rem'>"
            f"<h2>{title}</h2><p>{msg}</p></body></html>"
        ).encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        self.wfile.write(html)


def serve(client: dict, hours: float, report_after: bool = False):
    port = urllib.parse.urlparse(REDIRECT_URI).port or 3000
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(16)
    url = auth_url(client, challenge, state)

    holder = os.path.join(PROFILE_DIR, "gsc-auth-url.txt")
    os.makedirs(PROFILE_DIR, exist_ok=True)
    with open(holder, "w") as f:
        f.write(
            f"{url}\n\n# generated {datetime.now(timezone.utc).isoformat()}\n"
            f"# callback: {REDIRECT_URI}\n"
            f"# tunnel:   ssh -N -L {port}:127.0.0.1:{port} roux\n"
        )
    os.chmod(holder, 0o600)

    srv = http.server.HTTPServer(("127.0.0.1", port), _Handler)
    srv.timeout = 30
    deadline = time.time() + hours * 3600
    _Handler.expected_state = state
    _Handler.result = {}
    print(f"listening on 127.0.0.1:{port} (up to {hours:g}h)", flush=True)
    print("AUTHORIZE URL:\n" + url, flush=True)
    print(f"(also written to {holder})", flush=True)

    code, got_state = None, None
    while time.time() < deadline and code is None:
        srv.handle_request()
        r = _Handler.result
        if r.get("error"):
            raise SystemExit(f"authorization denied: {r['error']}")
        if r.get("code"):
            code, got_state = r["code"], r.get("state")
    if not code:
        raise SystemExit("timed out waiting for authorization")
    if got_state != state:
        raise SystemExit("state mismatch -- authorization code ignored")
    tok = exchange(client, code, verifier)
    if "refresh_token" not in tok:
        raise SystemExit("no refresh_token returned; re-run with prompt=consent")
    path = save_token(client, tok)
    at = tok["access_token"]
    print(f"saved refresh token to {path} (0600)")
    print(f"authorized account: {identity(at)}")
    print(f"granted scope: {tok.get('scope')}")

    if report_after:
        # Prove the grant end-to-end while the human is still watching.
        import subprocess

        out_path = os.path.expanduser("~/workspace/hanews-gsc-first-report.txt")
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gsc_report.py")
        proc = subprocess.run(
            [sys.executable, script], capture_output=True, text=True, timeout=180
        )
        with open(out_path, "w") as f:
            f.write("# first live Search Console report after authorization\n\n")
            f.write(proc.stdout or "")
            if proc.returncode != 0:
                f.write("\n# STDERR\n" + proc.stderr[-3000:])
        print(f"first report written to {out_path} (exit {proc.returncode})")


def status(client: dict | None):
    if not os.path.exists(TOKEN_PATH):
        print(f"no token at {TOKEN_PATH}")
        return 1
    t = json.load(open(TOKEN_PATH))
    print(f"token file: {TOKEN_PATH} (mode {oct(os.stat(TOKEN_PATH).st_mode)[-3:]})")
    print(f"stored scope: {t.get('scope')}")
    print(f"obtained: {t.get('obtained_at')}")
    body = urllib.parse.urlencode(
        {
            "client_id": t["client_id"],
            "client_secret": t["client_secret"],
            "refresh_token": t["refresh_token"],
            "grant_type": "refresh_token",
        }
    ).encode()
    try:
        with urllib.request.urlopen(TOKEN_ENDPOINT, data=body, timeout=30) as r:
            tok = json.load(r)
    except urllib.error.HTTPError as e:
        print(f"refresh FAILED: HTTP {e.code} {e.read().decode()[:200]}")
        return 1
    print(f"refresh OK; account {identity(tok['access_token'])}")
    print(f"live scope: {tok.get('scope')}")
    return 0


def main():
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--client", help="path to OAuth client_secret JSON")
    ap.add_argument("--serve", action="store_true", help="run local callback listener")
    ap.add_argument("--hours", type=float, default=2.0, help="how long --serve waits")
    ap.add_argument("--url", action="store_true", help="print an authorization URL")
    ap.add_argument("--status", action="store_true", help="check the stored token")
    ap.add_argument("--exchange", metavar="CODE", help="exchange a pasted code")
    ap.add_argument(
        "--report-after",
        action="store_true",
        help="with --serve: run the report as soon as the token is saved",
    )
    args = ap.parse_args()

    client = load_client(args.client)
    if args.status:
        return status(client)
    if args.url:
        verifier, challenge = pkce_pair()
        url = auth_url(client, challenge, secrets.token_urlsafe(16))
        print(url)
        print(f"\n# code_verifier (needed for --exchange): {verifier}")
        return 0
    if args.exchange:
        ap2 = input("code_verifier from the --url run: ").strip() if not os.environ.get("GSC_VERIFIER") else os.environ["GSC_VERIFIER"]
        tok = exchange(client, args.exchange, ap2)
        if "refresh_token" not in tok:
            raise SystemExit("no refresh_token; the client must use access_type=offline")
        print(f"saved to {save_token(client, tok)}")
        return 0
    if args.serve:
        serve(client, args.hours, report_after=args.report_after)
        return 0
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main() or 0)
