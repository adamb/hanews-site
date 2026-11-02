# hanews-site

Live static site + Pages Functions for [hanews.org](https://hanews.org) (Home Assistant News).

## Deploy

- **Primary:** push / merge to `main` → GitHub Action `Deploy to Cloudflare Pages` runs `wrangler pages deploy` into the existing Pages project **`hanews`** (custom domains `hanews.org` / `www.hanews.org`, KV, and secrets stay on that project).
- Cloudflare cannot attach a Git source to a Direct Upload project, so production stays on `hanews` with CI instead of a native Pages↔Git link.
- **Break-glass (local):**  
  `CLOUDFLARE_ACCOUNT_ID=47fc5188afc9aa2306c4f30dc9e3cc30 npx wrangler@3 pages deploy . --project-name=hanews`

Do not change DNS or custom domains from this repo. Secrets (`ADMIN_PASSWORD`, `GA_MEASUREMENT_ID`, `IMPROVMX_API_KEY`, `OLLAMA_API_KEY`) live in the Pages project, not in git.

## Layout

- Root HTML/CSS/JS — newspaper pages and weekday briefs
- `functions/` — Pages Functions (`/subscribe`, `/confirm`, `/admin`, GA)
- `images/`, `shots/` — static assets
- `wrangler.toml` — local/Pages config (KV binding `SUBSCRIBERS`)

The Python intelligence pipeline remains in a separate repo: [adamb/hanews](https://github.com/adamb/hanews).

## Search Console reporting

`scripts/gsc_report.py` pulls Google Search Console data (clicks, impressions,
CTR, average position, top queries, top pages, sitemap submitted-vs-indexed) for
the last 28 days, ending 3 days back because Search Console data lags ~2-3 days.
`scripts/gsc_oauth.py` is the one-time, read-only authorization helper.

- Scope: `https://www.googleapis.com/auth/webmasters.readonly` only.
- Token: `~/.hermes/profiles/hanews/gsc-token.json` (mode 0600, outside this
  repo; `gsc-token*.json` is git-ignored). Never commit a token or client secret.
- Property matching tries `https://hanews.org/`, `https://hanews.org`, then
  `sc-domain:hanews.org`, so the script works with either property type.
- Authorize: `python3 scripts/gsc_oauth.py --serve --hours 72 --report-after`
  then open the printed URL through `ssh -N -L 3000:127.0.0.1:3000 <vps>`.
- Check the grant: `python3 scripts/gsc_oauth.py --status`.
- Weekly: the hanews cron job `hanews-weekly-search-console` runs
  `gsc_report.py --json` and posts a short digest to bot-chat (Mondays).
  The daily progress report folds the same numbers into its SEO section.

