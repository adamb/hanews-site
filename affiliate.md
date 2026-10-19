# HA News affiliate link map

Standing project config: Associates tracking tag is `hanews01-20` — the standing tag for every future affiliate link on hanews.org (Associates account opened 2026-10-19; 3-sales/180-day approval window applies). Owned by the editing agent; Adam never needs to supply links by hand.

Associates tag: `hanews01-20` (Adam's approved tracking tag).

Every generated link carries `tag=hanews01-20`. Until Adam supplies exact
ASIN/SiteStripe links, entries resolve to tagged Amazon **search** URLs of the
form:

    https://www.amazon.com/s?k=<urlencoded product name>&tag=hanews01-20

Tagged search links are Associates-compliant and fully replaceable: when Adam
pastes an exact `amzn.to` or `/dp/ASIN?tag=hanews01-20` link into this file,
regenerate the page rows (and the affected story HTML) so the exact product
page — not a search — gets the tag.

## Format

    ## <page>.html#<story-anchor>
    - <product name as shown in story> → <product name for search URL>

## Map

### article-thread-network.html
- Home Assistant ZBT-2 → Home Assistant ZBT-2 Thread border router
- Home Assistant Green → Home Assistant Green hub
- Inovelli White Series switch → Inovelli White Series Matter Thread switch
- Eve Light Switch → Eve Light Switch Thread Matter
- Onvis plug (exact) → https://www.amazon.com/Onvis-Matter-Thread-Outlet-Google/dp/B0FRFPV5FK?tag=hanews01-20
- ECOWITT weather station (exact) → https://www.amazon.com/dp/B0BM3BQ425?tag=hanews01-20
- Smartwings shade → Smartwings matter over thread roller shade (merchant: smartwingshome.com direct, non-affiliate; Amazon tagged search)
- IKEA MYGGBETT → IKEA MYGGBETT door window sensor Matter (IKEA store direct; Amazon tagged search)
- IKEA MYGGSPRAY → IKEA MYGGSPRAY motion sensor Matter (Amazon tagged search)
- IKEA BILRESA dual button → IKEA BILRESA dual button remote Matter (Amazon tagged search)
- IKEA BILRESA scroll wheel → IKEA BILRESA scroll wheel remote Matter (Amazon tagged search)
- IKEA KAJPLATS → (IKEA store direct only; bulb item 30611462)

### brief-2026-10-19.html#huepro
- Philips Hue Play Gradient Strip Pro (65") → Philips Hue Play Gradient LightStrip Pro 65 inch

### brief-2026-10-16.html#huepro (and prior briefs reusing the same watch item)
- Philips Hue Play Gradient Strip Pro (65") → Philips Hue Play Gradient LightStrip Pro 65 inch

### article-esphome-starter-kit.html and explainer-esphome-kit.html
- ESP32 DevKit → ESP32 DevKitC development board
- Generic ESPHome-capable board (ESP32-S3) → ESP32-S3 development board ESPHome

### explainer-matter-15.html
- Matter 1.5 certified products (general device links) → Matter certified smart home devices

## Watched products (pending Adam's exact links)
- Aqara FP400 presence sensor — placeholder search: "Aqara FP400 presence sensor"
- Tapo Matter cameras — placeholder search: "Tapo Matter camera"
- Shelly ThreadLink — NOT purchasable yet (~Dec firmware rollout); no link until it ships
- IKEA TIMMERFLOTTE — community firmware only, not sold as-is; no link