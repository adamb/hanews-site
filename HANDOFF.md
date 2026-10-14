# HA News — Handoff to Hermes

Written 13 Oct 2026 by Grok Bot for Hermes (Adam Beguelin's agent on his VPS), which now owns HA News.

## 1. Project
- **hanews.org** is a home-automation news site. Tagline: *"Reporting the local stack, from radio to automations."*
- Home Assistant is a **section** (`ha.html`), not the paper's name. Sections: Home Assistant, Matter & Thread, ESPHome, Devices, Energy, Explainers, About.
- Monetization comes later, through ads (`advertise.html`) and newsletter placement.
- Static HTML + `styles.css`, served by Cloudflare Pages with Pages Functions in `functions/`.

## 2. Hard rules
- **No subscriber email blasts.** No DNS or domain changes. **No spending** unless Adam explicitly asks.
- **Never delete pre-existing files.**
- **Device stories must use real manufacturer photos** (press kit / official product images in `images/`, with source credited in the `figcaption`).
- **Publishing on your own is approved:** ship it, then ping Adam with the links to review.
- Any email Adam has the AI help with carries a footer naming the AI (e.g. "Written by Hermes").
- Never commit secret values or OAuth tokens.

## 3. Weekday brief
**Schedule:** Mon–Fri around **7:54 AM AST** (America/Puerto_Rico).

**Check upstream each morning:**
- Home Assistant Core, Supervisor (stable channel pin), HAOS, ESPHome, Z-Wave JS UI, Zigbee2MQTT (GitHub releases / version JSON).
- Matter / Thread news (CSA, OHF, vendor firmware).
- Watched products: Hue Play gradient strip pro (UK and US stock pages), Aqara FP400, Tapo Matter cameras, Shelly ThreadLink (expected ~Dec), IKEA (TIMMERFLOTTE test firmware, Matter range).

**Pick a lead.** A real release or news item leads. On a quiet day use a *soft lead* (e.g. "Quiet Friday: still no Core 2026.9.4") and keep the rail honest with "still X" items.

**File pattern (copy the latest brief and edit):**
- New file at repo root: `brief-YYYY-MM-DD.html`.
- `<title>Brief D Mon YYYY — HA News</title>` + a `meta description` summarizing the top items.
- Same masthead (dateline like `Tuesday, 29 September 2026`), section nav, signup modal, footer, and `<script src="/ga.js" defer>` as previous briefs.
- Body: `<main class="page"><div class="sheet page-with-rail"><div class="page-inner">` holding ~10 `<article class="story-block" id="...">` blocks. The lead is `id="lead"`; others use short slugs (`supervisor`, `core`, `haos`, `esphome`, `hue`, `z2m`, `tapo`, `timmerflotte`, ...).
- Each story-block: `<p class="meta">NN · Topic</p>`, `<h2>`, an optional `<figure class="figure">` (img + credited figcaption), `<p><strong>What happened:</strong> …</p>`, `<p><strong>Why it matters:</strong> …</p>`, then `<dl class="facts"><dt>Primary source</dt><dd><a …></a></dd></dl>`. Always link a primary source.
- **Update `index.html`:** the main `<h1>` lead link, the `h2` story links, the left rail (`aside.col-left`, section headline lists) and the right rail (`aside.col-right`), all pointing at the new brief's `#anchors`.

## 4. State
- **Last brief published: 2026-09-29** (lead: Z-Wave JS UI 11.24.2). Briefs have been **paused since 2026-09-29**.
- ⚠️ The 2026-09-29 brief went live through Wrangler, but **it was never committed**. At handoff time, `origin/main` ends at `c2d9de6` (28 Sep brief). `brief-2026-09-29.html` and the matching `index.html` edit exist only in Grok Bot's local clone and on the live site. Before you publish anything, recover them: pull them from the live site (https://hanews.org/brief-2026-09-29.html and https://hanews.org/) or ask Adam/Grok Bot to push them. Otherwise your next deploy will roll back the 29 Sep index.
- Last known stack: Core 2026.9.4, Supervisor 2026.09.3, HAOS 18.3, ESPHome 2026.9.0, Z-Wave JS UI 11.24.2, Z2M 2.14.1. These are stale now, so re-check everything.

## 5. Deploy
- Cloudflare Pages project **`hanews`** (account `47fc5188afc9aa2306c4f30dc9e3cc30`) serves **hanews.org**, **www.hanews.org**, and **hanews.pages.dev**. It is a Direct Upload project.
- `.github/workflows/deploy-pages.yml` runs `wrangler pages deploy . --project-name=hanews` on every push to `main` (and on workflow_dispatch).
- **Known breakage:** the repo secret `CLOUDFLARE_API_TOKEN` is a short-lived Wrangler OAuth token, so the Action fails. Adam needs to create a durable API token (**Account → Cloudflare Pages → Edit**) and set it as that secret, and give one to Hermes.
- **Break-glass path:** `wrangler pages deploy . --project-name=hanews` from the repo root.
- Secondary Git-native project **`hanews-site`** (hanews-site.pages.dev) holds preview builds only, with no domains attached.
- `wrangler.toml`: name `hanews`, output dir `.`, KV binding `SUBSCRIBERS`.

## 6. Pages config on `hanews` (names only)
- Secrets: `ADMIN_PASSWORD`, `GA_MEASUREMENT_ID`, `IMPROVMX_API_KEY`, `OLLAMA_API_KEY`.
- KV `SUBSCRIBERS`, id `0f64d5199cb844eab5bc654e61496a65`.
- ImprovMX sends the subscription confirm emails.
- Functions: `functions/subscribe.js`, `confirm.js`, `ga.js`, `_middleware.js`, and `functions/admin/` (login/logout/index/generate, `_lib.js`).

## 7. Open items
1. Durable Cloudflare API token (Pages Edit) for the GitHub secret and for Hermes.
2. Gmail drops confirm emails that contain links. The workaround is a direct link.
3. Keep or retire the old Python pipeline repo `adamb/hanews`.
4. Decide whether to mothball the Pages project `hanews-site`.
5. Recover the uncommitted 29 Sep brief (see §4).

## 8. What Hermes needs on the VPS
- A GitHub push credential for `adamb/hanews-site`.
- A durable Cloudflare API token (Pages Edit on the account above) for Wrangler.
- A scheduler (cron or the agent's own) for the weekday 7:54 AM AST run.
- Node + `wrangler` for the break-glass deploy.

Grok Bot's routine stays paused, so only Hermes publishes from here on. Never run two briefs on the same day.
