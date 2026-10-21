"""Single source of truth for public URLs on hanews.org.

Cloudflare Pages serves the site at extensionless paths: `/about` is the
page, `/about.html` is a 308 redirect to it. Two things follow, and both used
to be wrong in this repo:

  1. A `<link rel="canonical">` must point at the page itself. Pointing it at
     `/about.html` tells a crawler the real version lives one redirect away.
  2. A `<loc>` in sitemap.xml should be the page, not the redirect. A sitemap
     full of redirects is a sitemap that hands crawlers 33 hops of work
     before they reach a page.

So every public URL this site emits goes through `canonical_url()` here.
The home page canonicalises to the bare site root, `https://hanews.org/`.
"""

import os

SITE = "https://hanews.org"


def canonical_url(path):
    """Return the canonical, extensionless URL for a repo-relative page path.

    `path` may be a bare filename or a repo-relative path; only the basename
    matters, because every page on this site lives at the site root.

        canonical_url("index.html")   -> https://hanews.org/
        canonical_url("about.html")   -> https://hanews.org/about
        canonical_url("brief-2026-10-19.html")
                                    -> https://hanews.org/brief-2026-10-19
    """
    name = os.path.basename(path)
    if name == "index.html":
        return SITE + "/"
    return "{}/{}".format(SITE, os.path.splitext(name)[0])
