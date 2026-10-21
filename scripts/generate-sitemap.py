#!/usr/bin/env python3
"""Generate sitemap.xml for hanews.org from the tracked HTML files and git dates.

The sitemap must not be hand-typed: briefs get added to the repo constantly, and
a stale sitemap is worse than no sitemap. This script reads the real file list
from git and the real per-file commit dates, so it stays correct on every push.

Run from anywhere:
    python3 scripts/generate-sitemap.py

Wired into .github/workflows/deploy-pages.yml so every push regenerates it
before the Cloudflare Pages upload.
"""

import datetime
import os
import subprocess
import sys
from xml.sax.saxutils import escape

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://hanews.org"
OUTPUT = os.path.join(REPO_ROOT, "sitemap.xml")

# Diagnostic file and the 404 document are not indexable pages.
EXCLUDE = {"_probe.html", "404.html"}


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
    pages = []
    for path in out.splitlines():
        path = path.strip()
        if not path:
            continue
        if os.path.basename(path) in EXCLUDE:
            continue
        if not os.path.isfile(os.path.join(REPO_ROOT, path)):
            continue
        pages.append(path)
    return sorted(pages)


def lastmod(path):
    """Last commit date for the file, YYYY-MM-DD."""
    stamp = git("log", "-1", "--format=%cs", "--", path)
    if not stamp:
        return datetime.date.today().isoformat()
    return stamp[:10]


def cadence(path):
    """(changefreq, priority) per the site content policy."""
    name = os.path.basename(path)
    if name == "index.html":
        return "daily", "1.0"
    if name.startswith("brief-"):
        return "daily", "0.8"
    if name.startswith("article-") or name.startswith("explainer-"):
        return "weekly", "0.6"
    if name in ("about.html", "advertise.html"):
        return "weekly", "0.3"
    return "weekly", "0.4"


def main():
    pages = tracked_pages()
    if not pages:
        sys.stderr.write("no tracked HTML pages found; refusing to write an empty sitemap\n")
        return 1

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ]
    for path in pages:
        changefreq, priority = cadence(path)
        loc = "{}/{}".format(SITE, path)
        lines.append("  <url>")
        lines.append("    <loc>{}</loc>".format(escape(loc)))
        lines.append("    <lastmod>{}</lastmod>".format(escape(lastmod(path))))
        lines.append("    <changefreq>{}</changefreq>".format(changefreq))
        lines.append("    <priority>{}</priority>".format(priority))
        lines.append("  </url>")
    lines.append("</urlset>")
    lines.append("")

    with open(OUTPUT, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))

    print("wrote {} with {} urls".format(OUTPUT, len(pages)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
