#!/usr/bin/env python3
"""Normalise <head> metadata across the tracked HTML pages.

Adds, only where missing:
  - <link rel="canonical" href="https://hanews.org/<file>.html">
  - <meta name="robots" content="index, follow">
  - <script src="/ga.js" defer></script>  (only for brief-2026-10-14.html)

Existing <meta charset>, <meta name="viewport">, <title>, <meta name="description">,
<link rel="stylesheet"> and script tags are left exactly as they are. The script
is idempotent: re-running it makes no further changes.

    python3 scripts/add-head-meta.py [--check]

--check reports what would change and exits non-zero if anything is missing.
"""

import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://hanews.org"

# Diagnostic file: leave it alone.
SKIP = {"_probe.html"}

# The 404 document is not an indexable page: it carries its own noindex tag
# by hand, so the normaliser must not stamp a canonical/index,follow on it.
SKIP_404 = {"404.html"}

# Pages that must carry the analytics tag.
NEED_GA = {"brief-2026-10-14.html"}

CANONICAL_RE = re.compile(r'rel=["\']canonical["\']', re.I)
ROBOTS_RE = re.compile(r'<meta[^>]+name=["\']robots["\']', re.I)
GA_RE = re.compile(r'src=["\']/ga\.js["\']', re.I)

HEAD_RE = re.compile(r'(<head\b[^>]*>)(.*?)(</head>)', re.I | re.S)

# Anchor candidates, in preference order: insert after the first one found.
ANCHORS = [
    re.compile(r'<meta[^>]+name=["\']description["\'][^>]*>', re.I),
    re.compile(r'<title\b.*?</title>', re.I | re.S),
    re.compile(r'<meta[^>]+name=["\']viewport["\'][^>]*>', re.I),
    re.compile(r'<meta[^>]+charset[^>]*>', re.I),
]


def git(*args):
    return subprocess.run(
        ("git",) + args,
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def tracked_pages():
    out = git("ls-files", "*.html")
    return [
        p.strip()
        for p in out.splitlines()
        if p.strip()
        and os.path.basename(p.strip()) not in SKIP
        and os.path.basename(p.strip()) not in SKIP_404
    ]


def indent_at(text, index):
    """Leading whitespace of the line containing index."""
    start = text.rfind("\n", 0, index) + 1
    line = text[start:index]
    return line[: len(line) - len(line.lstrip())] or ""


def insert_after(text, snippet, anchor=None):
    """Insert snippet after the first matching anchor, else before </head>."""
    patterns = ANCHORS if anchor is None else [anchor]
    for pattern in patterns:
        match = pattern.search(text)
        if not match:
            continue
        pad = indent_at(text, match.start())
        return text[: match.end()] + "\n" + pad + snippet + text[match.end() :]
    return text.replace("</head>", "  " + snippet + "\n</head>", 1)


def process(path, check_only=False):
    full = os.path.join(REPO_ROOT, path)
    with open(full, encoding="utf-8") as handle:
        original = handle.read()

    head_match = HEAD_RE.search(original)
    if not head_match:
        return path, ["no <head> block found"], None

    head = head_match.group(2)
    changes = []

    if not CANONICAL_RE.search(head):
        canonical = '<link rel="canonical" href="{}/{}">'.format(SITE, path)
        head = insert_after(head, canonical)
        changes.append("canonical")

    if not ROBOTS_RE.search(head):
        head = insert_after(
            head,
            '<meta name="robots" content="index, follow">',
            anchor=re.compile(r'<link[^>]+rel=["\']canonical["\'][^>]*>', re.I),
        )
        changes.append("robots")

    if os.path.basename(path) in NEED_GA and not GA_RE.search(head):
        head = insert_after(
            head,
            '<script src="/ga.js" defer></script>',
            anchor=re.compile(r'<meta[^>]+name=["\']robots["\'][^>]*>', re.I),
        )
        changes.append("ga.js")

    if not changes:
        return path, [], original

    if not check_only:
        updated = (
            original[: head_match.start(2)]
            + head
            + original[head_match.end(2) :]
        )
        with open(full, "w", encoding="utf-8") as handle:
            handle.write(updated)

    return path, changes, None


def main():
    check_only = "--check" in sys.argv
    touched = []
    for path in tracked_pages():
        path, changes, _ = process(path, check_only=check_only)
        if changes:
            touched.append((path, ",".join(changes)))
            print("{}: +{}".format(path, ",".join(changes)))
    print("PAGES_CHANGED={}".format(len(touched)))
    if check_only and touched:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
