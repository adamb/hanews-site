#!/usr/bin/env python3
"""topic-explore.py — free-model topic exploration for HA News.

Pipeline (cost target: $0.00):
  1. Arctic Shift  -> last-24h posts from the HA watchlist subreddits.
  2. flint (free)  -> triage: cut the pile down to candidate leads.
  3. nemotron-3-ultra (free) -> editor pass: 3 ranked pitches, house format.

Reddit is a TIP feed only. Nothing here may be published as a claim: every
pitch carries the Reddit thread as provenance and the primary source that
must be verified before a word gets written.

Usage:
  python3 scripts/topic-explore.py              # scan + pitch
  python3 scripts/topic-explore.py --scan-only  # just dump signals
  python3 scripts/topic-explore.py --hours 48   # wider window
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ARCTIC = "https://arctic-shift.photon-reddit.com/api/posts/search"
WATCHLIST = ["homeassistant", "homeautomation", "Esphome",
             "zigbee", "zwave", "homekit", "MatterSmartHome"]
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
FIELDS = "title,created_utc,score,id,selftext,subreddit"

# Free models only. Never add a paid model here: a fallback that reaches a
# paid model is billed even though the first model was :free.
# Measured on the real 24h signal pack (~34KB, 127 posts), 2026-11-05:
#   nemotron-3-ultra + reasoning DISABLED -> 14.6s, 7/7 valid JSON leads, 0
#     thinking tokens. Best triage config by a wide margin.
#   flint -> reasoning is mandatory on its endpoint; it burned 4,161 tokens
#     thinking and returned an EMPTY string. Only usable with a huge budget.
#   gemma-4 / xing4.0 -> 429 upstream on every attempt. Do not rely on them.
#   dots-3-note, nano-omni -> also returned empty (thinking ate the budget).
TRIAGE_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"
EDITOR_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"
SPARE_MODELS = ["openrouter/free",  # router that only falls back among free models
                "recursive/flint-v1.0:free",
                "dots-studio/dots-3-note-preview:free"]

OUT_DIR = Path.home() / "workspace" / "topic-pitches"


def env() -> dict:
    p = Path.home() / ".hermes/profiles/hanews/.env"
    out = {}
    if p.exists():
        for line in p.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k] = v
    for k in ("OPENROUTER_API_KEY", "IMPROVMX_API_KEY"):
        if k in os.environ:
            out[k] = os.environ[k]
    return out


def http_json(url: str, timeout: int = 45):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


# ---------------------------------------------------------------- signals ---

def fetch_arctic(sub: str, hours: int) -> list:
    """Arctic Shift search. 422 on some param combos (documented quirk), so
    retry once with an epoch-seconds `after` and a smaller limit."""
    attempts = [{"after": f"{hours}h", "limit": "60"},
                {"after": str(int(time.time()) - hours * 3600), "limit": "25"}]
    for i, extra in enumerate(attempts):
        q = {"subreddit": sub, "fields": FIELDS, **extra}
        url = ARCTIC + "?" + urllib.parse.urlencode(q)
        try:
            d = http_json(url)
            return d.get("data", []) or []
        except urllib.error.HTTPError as e:
            print(f"  ! {sub}: HTTP {e.code} (attempt {i+1})", file=sys.stderr)
            if e.code == 429:
                time.sleep(5)
            elif e.code != 422:
                return []
        except Exception as e:  # noqa: BLE001
            print(f"  ! {sub}: {e!r}", file=sys.stderr)
            return []
        time.sleep(1.5)
    return []


def fetch_rss(sub: str, hours: int = 24) -> list:
    """Atom fallback. Arctic Shift does not carry every sub (r/zwave, r/matter,
    r/SmartThings return 200 with an empty list), so empty != quiet.

    Back-to-back RSS requests get 429; callers space them ~3s.
    """
    import xml.etree.ElementTree as ET
    url = f"https://www.reddit.com/r/{sub}/new/.rss"
    ns = {"a": "http://www.w3.org/2005/Atom"}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        raw = urllib.request.urlopen(req, timeout=30).read()
        root = ET.fromstring(raw)
        out = []
        cutoff = time.time() - hours * 3600
        for e in root.findall("a:entry", ns):
            # /new/.rss on a quiet sub returns month-old posts; filter or the
            # "24h" window silently lies.
            stamp = (e.findtext("a:updated", default="", namespaces=ns)
                     or e.findtext("a:published", default="", namespaces=ns) or "")
            try:
                from datetime import datetime as _dt
                when = _dt.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
                if when < cutoff:
                    continue
            except Exception:  # noqa: BLE001
                pass
            link = e.find("a:link", ns)
            href = (link.get("href") if link is not None else "") or ""
            m = re.search(r"/comments/([a-z0-9]+)/", href)
            title = (e.findtext("a:title", default="", namespaces=ns) or "").strip()
            if not m or not title:
                continue
            out.append({"id": m.group(1), "sub": sub, "title": title, "body": "",
                        "score": 0, "url": href.split("?")[0]})
        return out
    except Exception as e:  # noqa: BLE001
        print(f"  ! rss {sub}: {e!r}", file=sys.stderr)
        return []


def collect(hours: int) -> list:
    posts, seen = [], set()
    for sub in WATCHLIST:
        got = fetch_arctic(sub, hours)
        src = "arctic"
        if not got:
            time.sleep(3.0)  # RSS 429s if hammered
            got = fetch_rss(sub, hours)
            src = "rss" if got else "empty"
        print(f"  {sub}: {len(got)} posts ({src})")
        for p in got:
            pid = p.get("id")
            if not pid or pid in seen:
                continue
            seen.add(pid)
            posts.append({
                "id": pid,
                "sub": p.get("subreddit", sub),
                "title": (p.get("title") or "").strip(),
                "body": re.sub(r"\s+", " ", (p.get("selftext") or ""))[:400],
                "score": p.get("score") or 0,
                "url": p.get("url") or f"https://www.reddit.com/r/{sub}/comments/{pid}/",
            })
        time.sleep(1.2)  # be considerate; 429 otherwise
    return posts


# ----------------------------------------------------------------- models ---

def ask(model: str, prompt: str, max_tokens: int = 2400, retries: int = 4,
        reasoning: dict | None = None) -> str:
    key = env().get("OPENROUTER_API_KEY")
    if not key:
        raise SystemExit("OPENROUTER_API_KEY missing from ~/.hermes/profiles/hanews/.env")
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0.6,
    }
    if reasoning is not None:
        body["reasoning"] = reasoning
    body = json.dumps(body).encode()
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions", data=body,
            headers={"Authorization": f"Bearer {key}",
                     "Content-Type": "application/json",
                     "X-Title": "hanews-topic-explore"})
        try:
            d = json.loads(urllib.request.urlopen(req, timeout=240).read())
            txt = (d["choices"][0]["message"].get("content") or "").strip()
            cost = d.get("usage", {}).get("cost", 0)
            if cost:
                print(f"  !! {model} billed ${cost} — free-tier assumption broken", file=sys.stderr)
            return txt
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}: {e.read()[:200].decode(errors='replace')}"
            print(f"  ! {model}: {last}", file=sys.stderr)
            if e.code in (429, 503):
                time.sleep(10 * (attempt + 1))  # free tier throttles in bursts
                continue
            break
        except Exception as e:  # noqa: BLE001
            last = repr(e)[:200]
            print(f"  ! {model}: {last}", file=sys.stderr)
            time.sleep(4)
    raise RuntimeError(last or "model call failed")


def ask_with_spares(prompt: str, primary: str, max_tokens: int = 2400,
                    reasoning: dict | None = None) -> tuple:
    for m in [primary] + [x for x in SPARE_MODELS if x != primary]:
        try:
            # A model with reasoning enabled may spend the entire completion
            # budget thinking and return "". Give those a much larger budget.
            budget = max_tokens if not reasoning else max(max_tokens, 12000)
            txt = ask(m, prompt, max_tokens=budget, reasoning=reasoning)
            if txt:
                return txt, m
        except RuntimeError:
            continue
    raise SystemExit("all free models failed (upstream 429). Try again later.")


# ------------------------------------------------------------------ stages ---

TRIAGE_PROMPT = """You are the assignment desk for HA News, a trade paper for people who run their own homes in software (Home Assistant, ESPHome, Zigbee, Z-Wave, Thread, Matter). Readers run real houses; every story answers "should I update, buy, or wait?".

Below are raw community posts from the last {hours}h. Most are support questions, show-and-tell, or duplicates. Your job is triage only.

Keep a post ONLY if it points at something that is NEWS: a release, a version bump, a new product, an acquisition, a price change, a deprecation, a security issue, or a hardware failure pattern affecting many users. Kill support questions, "look at my dashboard", memes, and anything that is only one person's config problem.

Return a JSON array, nothing else. Each element:
{{"lead": "<one factual line, no hype>", "kind": "release|product|pricing|security|deprecation|incident", "why": "<8 words max>", "evidence": "<the thread title that triggered it>", "url": "<the post url>", "verify_at": "<the primary source a reporter must check>"}}

Max 8 leads. If nothing qualifies, return [].

POSTS:
{posts}"""

EDITOR_PROMPT = """You are the editor of HA News. Tagline: "Reporting the local stack, from radio to automations."

Here are {n} triaged leads from today's community scan. Each is a TIP, not a verified fact — none may be published without checking the primary source.

{leads}

Choose the 3 strongest and write pitches for articles that would earn search traffic from people who run their own homes. Favor the lead with the widest blast radius (something that touches many existing installs) or the clearest buy/wait decision.

For each pitch, exactly 4 lines:
LINE 1: headline — calm, specific, no hype, no clickbait, no emoji
LINE 2: the reader question it answers, starting with "Should I"
LINE 3: why now, naming the specific lead
LINE 4: the primary source that must be verified first (URL or doc name)

No preamble, no numbering, no commentary outside the 12 lines. Separate pitches with one blank line."""


def run(hours: int, scan_only: bool) -> int:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"Scanning {len(WATCHLIST)} subreddits over {hours}h via Arctic Shift...")
    posts = collect(hours)
    print(f"Signals: {len(posts)} unique posts")
    if not posts:
        print("No signals returned; aborting (nothing to pitch).", file=sys.stderr)
        return 2

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / f"signals-{stamp}.json").write_text(json.dumps(posts, indent=1))

    if scan_only:
        for p in sorted(posts, key=lambda x: -x["score"])[:15]:
            print(f"  [{p['score']:>4}] r/{p['sub']}: {p['title'][:100]}")
        return 0

    # Rank by score only lightly — Arctic Shift scores lag ~36h.
    pack = "\n".join(
        f"- r/{p['sub']} | score {p['score']} | {p['title']} | {p['body'][:200]} | {p['url']}"
        for p in posts)
    print("\nStage 1 — triage (free model)...")
    triage_txt, triage_model = ask_with_spares(
        TRIAGE_PROMPT.format(hours=hours, posts=pack), TRIAGE_MODEL,
        max_tokens=3000, reasoning={"enabled": False})
    m = re.search(r"\[.*\]", triage_txt, re.S)
    try:
        leads = json.loads(m.group(0)) if m else []
    except json.JSONDecodeError:
        leads = []
    print(f"  {triage_model}: {len(leads)} leads")

    (OUT_DIR / f"leads-{stamp}.json").write_text(json.dumps(leads, indent=1))
    if not leads:
        print("Triage found nothing news-shaped today.")
        return 0

    print("Stage 2 — editor pass (free model)...")
    lead_txt = "\n".join(
        f"{i+1}. {l.get('lead')} [{l.get('kind')}] — why: {l.get('why')} — thread: {l.get('evidence')} — {l.get('url')} — verify at: {l.get('verify_at')}"
        for i, l in enumerate(leads))
    pitches, editor_model = ask_with_spares(
        EDITOR_PROMPT.format(n=len(leads), leads=lead_txt), EDITOR_MODEL,
        max_tokens=3000, reasoning={"effort": "low"})

    doc = [f"# Topic pitches — {stamp}", "",
           f"_Free-model exploration. Signals: {len(posts)} posts, {len(leads)} leads. "
           f"Triage: {triage_model}. Editor: {editor_model}. Cost: $0.00._", "",
           "Each lead below is a TIP from Reddit. Verify against the primary source "
           "before a single sentence reaches a brief or an article.", "",
           "## Pitches", "", pitches, "", "## Leads" ]
    for i, l in enumerate(leads, 1):
        doc.append(f"{i}. **{l.get('lead')}** ({l.get('kind')})")
        doc.append(f"   - thread: {l.get('evidence')} — {l.get('url')}")
        doc.append(f"   - verify: {l.get('verify_at')}")
    out = OUT_DIR / f"pitches-{stamp}.md"
    out.write_text("\n".join(doc) + "\n")
    print("\n" + pitches)
    print(f"\nWrote {out}")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--scan-only", action="store_true")
    a = ap.parse_args()
    sys.exit(run(a.hours, a.scan_only))
