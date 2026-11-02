#!/usr/bin/env python3
"""Search Console performance report for hanews.org.

Pulls, from the Google Search Console API (read-only, scope
https://www.googleapis.com/auth/webmasters.readonly):

  * site totals for the trailing 28-day window -- clicks, impressions, CTR,
    average position
  * top 25 queries and top 25 pages in that window
  * day-by-day clicks/impressions for the window (sparkline-style table)
  * property + sitemap state: submitted vs indexed URLs per sitemap

Search Console lags roughly 2-3 days, so the window ends `--lag` days before
today and the report header says so.

Token: ~/.hermes/profiles/hanews/gsc-token.json (written by scripts/gsc_oauth.py).
Nothing secret is printed; nothing secret is written into the repo.

Usage:
    python3 scripts/gsc_report.py               # human report
    python3 scripts/gsc_report.py --json         # same data as JSON
    python3 scripts/gsc_report.py --days 7       # shorter window
    python3 scripts/gsc_report.py --inspect URL  # optional URL Inspection call
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

API = "https://searchconsole.googleapis.com/webmasters/v3"
INSPECT_API = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
TOKEN_PATH = os.environ.get(
    "GSC_TOKEN_PATH", os.path.expanduser("~/.hermes/profiles/hanews/gsc-token.json")
)
# URL-prefix properties must match exactly, trailing slash included.
PROPERTY_CANDIDATES = [
    "https://hanews.org/",
    "https://hanews.org",
    "sc-domain:hanews.org",
]
SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"


class NoCredentials(RuntimeError):
    pass


def access_token() -> str:
    # Escape hatch for local testing only; the normal path is the refresh token.
    if os.environ.get("GSC_ACCESS_TOKEN"):
        return os.environ["GSC_ACCESS_TOKEN"]
    if not os.path.exists(TOKEN_PATH):
        raise NoCredentials(
            f"no Search Console token at {TOKEN_PATH}; run scripts/gsc_oauth.py --serve"
        )
    t = json.load(open(TOKEN_PATH))
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
            return json.load(r)["access_token"]
    except urllib.error.HTTPError as e:
        raise NoCredentials(
            f"token refresh failed (HTTP {e.code}): {e.read().decode()[:200]} -- "
            "re-authorize with scripts/gsc_oauth.py --serve"
        )


def call(url: str, token: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST" if data else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:500]
        hint = ""
        if "SERVICE_DISABLED" in detail or "has not been used in project" in detail:
            hint = (
                "\n  -> enable the Search Console API for the OAuth client's GCP "
                "project: https://console.cloud.google.com/apis/library/searchconsole.googleapis.com"
            )
        elif e.code == 403:
            hint = f"\n  -> the authorized account may not own the property {url}"
        raise SystemExit(f"API error HTTP {e.code}: {detail}{hint}")


def resolve_property(token: str) -> tuple[str, list[str]]:
    data = call(f"{API}/sites", token)
    entries = data.get("siteEntry") or []
    available = [s.get("siteUrl", "") for s in entries]
    for cand in PROPERTY_CANDIDATES:
        if cand in available:
            return cand, available
    for s in entries:
        if "hanews.org" in s.get("siteUrl", ""):
            return s["siteUrl"], available
    raise SystemExit(
        "no hanews.org property visible to this account; visible properties: "
        + (", ".join(available) or "none")
    )


def query(token: str, site: str, body: dict) -> dict:
    return call(
        f"{API}/sites/{urllib.parse.quote(site, safe='')}/searchAnalytics/query",
        token,
        body,
    )


def rows(resp: dict) -> list[dict]:
    return resp.get("rows") or []


def fmt_num(v) -> str:
    if v is None:
        return "-"
    return f"{v:,}" if isinstance(v, int) else f"{v:,.1f}"


def build(days: int, lag: int, row_limit: int) -> dict:
    token = access_token()
    site, available = resolve_property(token)
    end = date.today() - timedelta(days=lag)
    start = end - timedelta(days=days - 1)
    base = {"startDate": start.isoformat(), "endDate": end.isoformat()}
    lim = {"rowLimit": row_limit}

    total = rows(query(token, site, base))
    by_query = rows(query(token, site, dict(base, dimensions=["query"], **lim)))
    by_page = rows(query(token, site, dict(base, dimensions=["page"], **lim)))
    by_date = rows(query(token, site, dict(base, dimensions=["date"], rowLimit=days)))

    sm = call(f"{API}/sites/{urllib.parse.quote(site, safe='')}/sitemaps", token)
    sitemaps = []
    for s in sm.get("sitemap") or []:
        contents = s.get("contents") or [{}]
        c = contents[0]
        sitemaps.append(
            {
                "path": s.get("path"),
                "lastDownloaded": s.get("lastDownloaded"),
                "errors": s.get("errors", 0),
                "warnings": s.get("warnings", 0),
                "submitted": int(c.get("submitted", 0) or 0),
                "indexed": int(c.get("indexed", 0) or 0),
                "type": c.get("type"),
            }
        )
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "property": site,
        "other_properties": [p for p in available if p != site],
        "window": {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "days": days,
            "data_lag_days": lag,
        },
        "totals": {
            "clicks": (total[0]["clicks"] if total else 0),
            "impressions": (total[0]["impressions"] if total else 0),
            "ctr": (total[0]["ctr"] if total else 0.0),
            "position": (total[0]["position"] if total else 0.0),
        },
        "top_queries": [
            {
                "query": r["keys"][0],
                "clicks": r.get("clicks", 0),
                "impressions": r.get("impressions", 0),
                "ctr": r.get("ctr", 0.0),
                "position": r.get("position", 0.0),
            }
            for r in by_query
        ],
        "top_pages": [
            {
                "page": r["keys"][0],
                "clicks": r.get("clicks", 0),
                "impressions": r.get("impressions", 0),
                "ctr": r.get("ctr", 0.0),
                "position": r.get("position", 0.0),
            }
            for r in by_page
        ],
        "daily": [
            {
                "date": r["keys"][0],
                "clicks": r.get("clicks", 0),
                "impressions": r.get("impressions", 0),
            }
            for r in sorted(by_date, key=lambda r: r["keys"][0])
        ],
        "sitemaps": sitemaps,
    }


def render(d: dict) -> str:
    w = d["window"]
    t = d["totals"]
    out = []
    out.append(f"Search Console — {d['property']}")
    out.append(
        f"window {w['start']} → {w['end']} ({w['days']}d; GSC lags ~{w['data_lag_days']}d)"
    )
    out.append("")
    out.append(
        f"clicks {fmt_num(t['clicks'])} | impressions {fmt_num(t['impressions'])} | "
        f"CTR {t['ctr'] * 100:.2f}% | avg position {t['position']:.1f}"
    )
    out.append("")
    if d["daily"]:
        out.append("Daily (clicks / impressions)")
        peak = max((r["impressions"] for r in d["daily"]), default=0) or 1
        for r in d["daily"]:
            bar = "█" * max(0, round(24 * r["impressions"] / peak))
            out.append(f"  {r['date']}  {r['clicks']:>5} / {r['impressions']:>6}  {bar}")
        out.append("")
    out.append("Top queries")
    if not d["top_queries"]:
        out.append("  (no query data in window — normal for a newly indexed site)")
    else:
        out.append(f"  {'clicks':>6} {'impr':>7} {'ctr':>6} {'pos':>5}  query")
        for q in d["top_queries"][:15]:
            out.append(
                f"  {q['clicks']:>6} {q['impressions']:>7} "
                f"{q['ctr'] * 100:>5.1f}% {q['position']:>5.1f}  {q['query'][:60]}"
            )
    out.append("")
    out.append("Top pages")
    if not d["top_pages"]:
        out.append("  (no page data in window)")
    else:
        out.append(f"  {'clicks':>6} {'impr':>7} {'ctr':>6} {'pos':>5}  page")
        for p in d["top_pages"][:15]:
            path = p["page"].replace("https://hanews.org", "") or "/"
            out.append(
                f"  {p['clicks']:>6} {p['impressions']:>7} "
                f"{p['ctr'] * 100:>5.1f}% {p['position']:>5.1f}  {path[:60]}"
            )
    out.append("")
    out.append("Sitemaps / indexing")
    if not d["sitemaps"]:
        out.append("  (no sitemap registered on this property)")
    for s in d["sitemaps"]:
        out.append(
            f"  {s['path']}: submitted {s['submitted']}, indexed {s['indexed']}, "
            f"errors {s['errors']}, warnings {s['warnings']}, "
            f"last read {s['lastDownloaded'] or 'never'}"
        )
    if d["other_properties"]:
        out.append("")
        out.append("Other properties visible to this account: " + ", ".join(d["other_properties"]))
    out.append("")
    out.append(f"generated {d['generated_at']} (UTC)")
    return "\n".join(out)


def inspect(url: str) -> dict:
    token = access_token()
    site, _ = resolve_property(token)
    body = {"inspectionUrl": url, "siteUrl": site, "languageCode": "en-US"}
    return call(INSPECT_API, token, body)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Search Console report for hanews.org")
    ap.add_argument("--days", type=int, default=28)
    ap.add_argument("--lag", type=int, default=3, help="days of API lag to skip (default 3)")
    ap.add_argument("--limit", type=int, default=25, help="rows per dimension")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text")
    ap.add_argument("--inspect", metavar="URL", help="also run URL Inspection on one URL")
    args = ap.parse_args(argv)

    if args.inspect:
        print(json.dumps(inspect(args.inspect), indent=1)[:4000])
        return 0

    try:
        data = build(args.days, args.lag, args.limit)
    except NoCredentials as e:
        print(f"search-console: not authorized — {e}", file=sys.stderr)
        return 3
    print(json.dumps(data, indent=1) if args.json else render(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
