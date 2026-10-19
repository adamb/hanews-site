# HA News affiliate link map

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