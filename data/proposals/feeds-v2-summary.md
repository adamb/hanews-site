# HA News feeds v2 — research summary

Researched 16 Nov 2026, 11:55 PM AST. **Research only** — `hanews.org/feeds` and `adamb/hanews-site` were not changed. Every candidate below was fetched with `User-Agent: HANewsBot/1.0 (+https://hanews.org/feeds)`. The 60-day freshness cutoff is 17 Sep 2026. Full proposed list: `/workspace/hanews-desk/feeds-v2.json`.

The hourly cache already on `/feeds` is the right cadence. This pass is about **more relevant sources**, not a faster poll.

## Counts

| | v1 | v2 proposed |
|---|---:|---:|
| Active list | 40 | **70** |
| Keep as-is (still high-signal) | — | 14 |
| Replaced (Reddit RSS → Arctic Shift) | — | 5 |
| New additions | — | **31** |
| Kept but deprioritized (bottom of the page) | — | 20 |
| Dropped from the active list | — | 1 (Hackaday: home automation, now stale) |

### Additions by section

| Section | Added | Notes |
|---|---:|---|
| Home Assistant | 12 | Practical blogs, OHF Daily, YouTube how-tos; r/homeassistant is a *replace*, not an add |
| Matter & Thread | 3 | XDA Matter tag, Homekit News, r/homekit. r/MatterProtocol is a replace |
| OpenWrt & networking | 1 | r/HomeNetworking (Arctic Shift). r/openwrt is a replace |
| ESPHome & DIY | 1 | YouTube: digiblur DIY (camera comparisons). r/esphome is a replace |
| LoRaWAN & mesh radio | 2 | Official Meshtastic YouTube, r/meshcore (Arctic Shift; previously 429) |
| Smart home news | 12 | How-To Geek, Android Police, XDA, MakeUseOf, Tom's Guide, TechRadar, plus matching YouTube |

Primary river (keep + add + replace, i.e. not the industry-noise shelf): **50 feeds**. The 20 deprioritized ones stay in the file so the page can render them last.

## Top 10 new sources

1. **How-To Geek: Smart Home** (`/feed/category/smart-home/`) — The exact how-to voice Adam already said he would click (HA automations, gadgets you can drop after moving to HA). Category-scoped, not the site firehose.
2. **XDA: Matter tag** — Closest to his round-2 clicks: Thread vs Wi-Fi, leak sensors and locks, leaving Tuya's cloud, HA as the one Matter app.
3. **XDA: Smart Home** — HA-first practical pieces (using an Echo as HA voice hardware, moving off Gemini, cheap automations).
4. **Android Police: Smart Home** — Same outlet as the Thread piece he liked. Use `/feed/smart-home/` (tag feeds for Matter/HA 404).
5. **MakeUseOf: smart-home tag** — Seasonal, plain-language gadget how-tos. Do *not* use the Home category feed (furnace filters and extension cords).
6. **Local Smart Home Guide** — Buying advice and a weekly local-stack brief (HA deal prices, AUX-2, old Echo Shows as HA panels).
7. **OHF Daily** — Paulus Schoutsen's daily, plain-language note of what actually changed in HA / ESPHome / energy / voice.
8. **YouTube: mostlychris** — AUX-2, dashboards, ESPHome speakers, Aqara presence sensors, Marketplace — current and practical.
9. **YouTube: Automate Your Life** — "Worth buying / skip" lists, presence-sensor comparisons, best Matter devices.
10. **Tom's Guide: Smart Home** — Camera buying guides and home-security how-tos, in the same vein as the Ambient camera piece he clicked.

Honorable mentions: Derek Seaman's Home Assistant *tag* feed (UPS / Proxmox / iOS — use `/tag/home-assistant/feed`, not the comments-only category URL), YouTube Smart Home Junkie, Home Automation Weekly, TechRadar Smart Home.

## Reddit: use Arctic Shift, not reddit.com RSS

The five v1 Reddit feeds (r/homeassistant, r/openwrt, r/esphome, r/meshtastic, r/MatterProtocol) should switch intake to [Arctic Shift](https://arctic-shift.photon-reddit.com/api/posts/search). That is the same path `news.dev.pr` and `hanews-site/scripts/topic-explore.py` (`fetch_arctic`) already use.

Verified from this host with the HANewsBot UA (7-day window, 16 Nov 2026, ~11:50 PM AST):

- **Carried and recommended:** homeassistant, openwrt, esphome, meshtastic, MatterProtocol, plus new: homekit, HomeNetworking, homeautomation, meshcore.
- **Carried but not recommended:** smarthome (spam/too broad, same v1 reason), unifi / Ubiquiti (vendor support firehoses), zigbee (off remit), SmartThings (wrong stack), tasmota (only two score-1 posts in a week).
- **Not carried** (HTTP 200, empty list — empty ≠ quiet): **MatterSmartHome, matter, zwave**. Use r/MatterProtocol, not r/matter.
- `esphome` and `Esphome` return the same posts (case-insensitive).

**Scores lag ~36 hours.** On this probe the newest 40 r/homeassistant and r/HomeNetworking posts were almost all still score 1; quieter subs (openwrt, esphome) showed real scores sooner. Proposed intake for each Reddit source in `feeds-v2.json`:

```
type: arctic-shift
endpoint: https://arctic-shift.photon-reddit.com/api/posts/search
fields: title,created_utc,score,id,selftext,subreddit
after: 168h
limit: 60
min_score: 15 for busy subs (homeassistant, meshtastic, homekit, HomeNetworking);
           10 for homeautomation, meshcore; 8 for openwrt, esphome; 5 for MatterProtocol
min_score_age_hours: 36
link: https://www.reddit.com/r/{subreddit}/comments/{id}/
```

Quirks, confirmed:

- HTTP **422** on some param combos — retry with epoch-seconds `after` and `limit=25` (already in `fetch_arctic`).
- Do **not** request `fields=permalink` (HTTP 400: not a valid field).
- `old.reddit.com/.../.rss` returned **403** with this UA.
- `www.reddit.com/.../.rss` and `/top/.rss?t=week` worked on an isolated retry tonight, but they remain 429-prone when several subs are fetched together (the original production failure). Keep RSS only as a spaced fallback, not the primary intake.

## Existing feeds that are industry / changelog noise

Leave them in the file with `"status": "deprioritize"` and `"priority": "low"` so `/feeds` can render them last (the idea Adam already liked for industry news). Do not delete.

- **Home Assistant Contributors blog** — developer breaking changes.
- **HA Core / OS / Supervisor releases** — betas and changelogs; the official blog already covers stables.
- **CSA newsroom** — standards/industry, often Zigbee/Aliro reference designs. Worked (200) on this probe after a prior 403; still not homeowner reading.
- **Matter SDK releases** — SDK tags.
- **CNX Software OpenWrt / home automation / Meshtastic** — board and SoC launch news. Worked (200) on this probe after a prior 403; Adam skips chip/launch news.
- **ESPHome releases, Espressif, Shelly Media Center** — betas, chip-vendor news, and vendor PR (revenue growth).
- **ChirpStack releases, LoRa Alliance, MeshCore releases, Meshtastic firmware releases** — test tags, alliance partnerships, alpha/revoked firmware.
- **Hackaday OpenWrt / ESPHome / Meshtastic** — hack write-ups, which he skips. **Hackaday: home automation** is now also stale (31 Jul 2026) and should be dropped from the active list.
- **GL.iNet** stays as a normal keep, but it is vendor PR; not marked low because travel-router news is still on-topic.
- **Android Authority** stays, with the existing "often deal-heavy" caveat.

## Other problems and misses

- **Smart Home Junkie blog** TLS fails from this host (`unable to get local issuer certificate`). The YouTube feed is clean and is the one to add.
- **PCMag** and **Seeed Studio** tag feeds returned Cloudflare 403s. No usable PCMag smart-home feed confirmed.
- **MacRumors-HomeKit** looks like a scoped URL but is general Apple news (iOS betas, iPhone Duo). Skip; 9to5Mac HomeKit is already on the list.
- **SmartHomeScene** is fresh and popular, but the current river is Zigbee-heavy — omitted on remit.
- Strong sources that are **stale**: JuanMTech, onemarcfifty, SmallNetBuilder, Everything Smart Home's *blog* (YouTube is used instead), Liliputing HA/OpenWrt tags, Pocket-lint Smart Home.
- Official **Home Assistant YouTube** feed, plus Kiril Peyanski and The Smart Homemaker, returned 200 with **0 entries**.
- **Digital Trends** and **Engadget** "home" feeds are the wrong kind of home (deal roundups, toasters, soundbars).
- Several YouTube channels are active but were skipped as off-taste (Intermit.Tech / BeardedTinker tinkerer-shorts; Lawrence Systems / Crosstalk UniFi firehoses; DrZzs off-topic).
- CNX and CSA may still 403 from Cloudflare Pages even though they succeeded here. The v2 file notes that. They are deprioritized either way.
- No good fresh **OpenWrt how-to blog** turned up. onemarcfifty and SmallNetBuilder would have been perfect and are stale. r/openwrt + r/HomeNetworking (Arctic Shift) plus official announcements are the practical networking intake for now.

## What not to do until Adam says yes

Do not change the site, the repo, or `/feeds`. When he wants this built: add How-To Geek and the other high-priority sources, switch Reddit to Arctic Shift, and hang the deprioritized industry/changelog feeds at the bottom of the page.
