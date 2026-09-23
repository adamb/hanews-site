# hanews-site

Live static site + Pages Functions for [hanews.org](https://hanews.org) (Home Assistant News).

## Deploy

- **Primary:** push / merge to `main` → Cloudflare Pages project `hanews` builds and deploys.
- **Break-glass:** from a clean tree matching this repo,
  `CLOUDFLARE_ACCOUNT_ID=… npx wrangler@3 pages deploy . --project-name=hanews`

Do not change DNS or custom domains from this repo. Secrets (admin password, etc.) live in the Pages project, not in git.

## Layout

- Root HTML/CSS/JS — newspaper pages and weekday briefs
- `functions/` — Pages Functions (`/subscribe`, `/confirm`, `/admin`, GA)
- `images/`, `shots/` — static assets
- `wrangler.toml` — local/Pages config (KV binding `SUBSCRIBERS`)

The Python intelligence pipeline remains in a separate repo: [adamb/hanews](https://github.com/adamb/hanews).
