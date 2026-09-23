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
