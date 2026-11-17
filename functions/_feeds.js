// Server-side aggregation for /feeds.
// RSS/Atom feeds are fetched directly. Reddit subs use Arctic Shift, never
// reddit.com RSS. Cache the aggregate for one hour and keep the last good
// items when a source fails. Do not use the SUBSCRIBERS KV namespace.

export const USER_AGENT = "HANewsBot/1.0 (+https://hanews.org/feeds)";
export const HOUR_CACHE =
  "public, max-age=3600, s-maxage=3600, stale-while-revalidate=21600";
export const SHORT_CACHE = "public, max-age=120";

const FRESH_MS = 60 * 60 * 1000;
const CACHE_URL = "https://hanews.org/internal/feeds-aggregate-v3";
const MAX_BYTES = 800000;
const PARSE_ITEMS = 16;
const KEEP_ITEMS = 12;
const SECTION_LIMIT = 10;
const AST = "America/Puerto_Rico";
const ARCTIC_ENDPOINT = "https://arctic-shift.photon-reddit.com/api/posts/search";
const ARCTIC_FIELDS = "title,created_utc,score,id,selftext,subreddit";
const ARCTIC_WINDOW_HOURS = 168;
const ARCTIC_LIMIT = 60;
const ARCTIC_RETRY_LIMIT = 25;
// Posts newer than min_score_age_hours skip the score floor. Cap how many of
// those unscored posts we keep so a busy sub does not fill the river.
const FRESH_SCORE_CAP = 4;

const HOST_LIMIT = {
  "www.reddit.com": 1,
  "reddit.com": 1,
  "forum.openwrt.org": 1,
  "arctic-shift.photon-reddit.com": 1,
};

let inflight = null;

export function isArcticShift(feed) {
  const kind = String((feed && (feed.intake || feed.type || feed.format)) || "");
  return kind === "arctic-shift";
}

export function isLowPriority(feed) {
  if (!feed) return false;
  return feed.priority === "low" || feed.status === "deprioritize";
}

export function arcticSubreddit(feed) {
  if (!feed) return "";
  const direct = feed.subreddit || (feed.arctic && feed.arctic.subreddit) || "";
  if (/^[A-Za-z0-9_]{2,30}$/.test(direct)) return direct;
  try {
    const sub = new URL(feed.feed_url).searchParams.get("subreddit") || "";
    if (/^[A-Za-z0-9_]{2,30}$/.test(sub)) return sub;
  } catch (err) {
    /* no url */
  }
  return "";
}

export function activeFeeds(catalog) {
  const list = catalog && Array.isArray(catalog.feeds) ? catalog.feeds : [];
  return list.filter((feed) => {
    if (!feed || !feed.name || !feed.category) return false;
    if (feed.status === "dropped") return false;
    if (isArcticShift(feed)) return !!arcticSubreddit(feed);
    if (!feed.feed_url) return false;
    return /^https?:\/\//i.test(String(feed.feed_url));
  });
}

export function categoriesOf(catalog, feeds) {
  if (catalog && Array.isArray(catalog.categories) && catalog.categories.length) {
    return catalog.categories.slice();
  }
  const seen = [];
  for (const feed of feeds || []) {
    if (feed.category && !seen.includes(feed.category)) seen.push(feed.category);
  }
  return seen;
}

export function cacheControlFor(aggregate) {
  const feeds = (aggregate && aggregate.feeds) || [];
  const useful = feeds.some((feed) => feed.ok || (feed.items && feed.items.length));
  return useful ? HOUR_CACHE : SHORT_CACHE;
}

export function aggregateFreshForMs(feeds) {
  const blocked = (feeds || []).some(
    (feed) => feed && feed.intake === "arctic-shift" && !feed.ok && feed.error === "HTTP 429"
  );
  return blocked ? 90 * 1000 : FRESH_MS;
}

export async function getAggregate(catalog) {
  if (inflight) return inflight;
  inflight = loadAggregate(catalog).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function loadAggregate(catalog) {
  const feeds = activeFeeds(catalog);
  const stored = await readStored();
  const age = stored ? ageMs(stored.refreshedAt) : Infinity;
  const freshFor = stored && stored.freshForMs ? stored.freshForMs : FRESH_MS;
  if (stored && age >= -60000 && age < freshFor) {
    return { aggregate: stored, cache: "hit" };
  }
  try {
    const started = Date.now();
    const fresh = await refreshFeeds(feeds);
    const merged = mergeResults(stored, fresh);
    const aggregate = {
      refreshedAt: new Date().toISOString(),
      stale: false,
      freshForMs: aggregateFreshForMs(merged),
      feeds: merged,
    };
    await writeStored(aggregate);
    const failed = merged.filter((feed) => !feed.ok);
    console.log(
      "feeds refresh ok=" +
        (merged.length - failed.length) +
        " fail=" +
        failed.length +
        " ms=" +
        (Date.now() - started)
    );
    for (const feed of failed) {
      console.log("feeds fail " + feed.name + " " + (feed.error || ""));
    }
    return { aggregate, cache: "refresh" };
  } catch (err) {
    console.log("feeds refresh failed");
    if (stored && Array.isArray(stored.feeds)) {
      return { aggregate: { ...stored, stale: true }, cache: "stale" };
    }
    const now = new Date().toISOString();
    return {
      aggregate: {
        refreshedAt: now,
        stale: true,
        feeds: feeds.map((feed) => ({
          name: feed.name,
          site_url: feed.site_url || "",
          feed_url: feed.feed_url,
          category: feed.category,
          ok: false,
          error: "unavailable",
          fetchedAt: now,
          lastOkAt: null,
          retained: false,
          items: [],
        })),
      },
      cache: "stale",
    };
  }
}

export function mergeResults(previous, current) {
  const prevBy = new Map();
  for (const feed of (previous && previous.feeds) || []) {
    prevBy.set(feed.feed_url, feed);
  }
  return current.map((feed) => {
    if (feed.ok) return { ...feed, retained: false, lastOkAt: feed.fetchedAt };
    const prev = prevBy.get(feed.feed_url);
    if (prev && prev.items && prev.items.length && (prev.ok || prev.lastOkAt)) {
      return {
        ...feed,
        items: prev.items,
        lastOkAt: prev.lastOkAt || prev.fetchedAt,
        retained: true,
      };
    }
    return { ...feed, items: [], retained: false, lastOkAt: null };
  });
}

export async function refreshFeeds(feeds, opts = {}) {
  const concurrency = opts.concurrency || 12;
  const indexed = (feeds || []).map((feed, index) => ({ feed, index }));
  const arctic = indexed.filter((row) => isArcticShift(row.feed));
  const rest = indexed.filter((row) => !isArcticShift(row.feed));
  const arcticConcurrency = Math.min(opts.arcticConcurrency || 1, concurrency);
  const out = new Array(indexed.length);
  const [arcticRows, restRows] = await Promise.all([
    runPool(arctic, arcticConcurrency, opts),
    runPool(rest, concurrency, opts),
  ]);
  for (const row of arcticRows.concat(restRows)) out[row.index] = row.result;
  return out;
}

async function runPool(rows, concurrency, opts) {
  const gates = new Map();

  async function withHost(host, fn) {
    const limit = HOST_LIMIT[host] || concurrency;
    if (!gates.has(host)) gates.set(host, { active: 0, queue: [] });
    const gate = gates.get(host);
    if (gate.active >= limit) {
      await new Promise((resolve) => gate.queue.push(resolve));
    }
    gate.active += 1;
    try {
      const result = await fn();
      if (result && result.error === "HTTP 429" && isRedditHost(host) && opts.staggerMs !== 0) {
        await sleep(1500);
      }
      return result;
    } finally {
      if (HOST_LIMIT[host] && opts.staggerMs !== 0) {
        let pause = opts.staggerMs;
        if (pause == null) {
          if (isRedditHost(host)) pause = 1200;
          else if (host === "forum.openwrt.org") pause = 250;
          else if (host === "arctic-shift.photon-reddit.com") pause = 700;
          else pause = 0;
        }
        await sleep(pause);
      }
      gate.active -= 1;
      const next = gate.queue.shift();
      if (next) next();
    }
  }

  const results = await mapLimit(rows, concurrency, (row) => {
    let host = "";
    try {
      host = new URL(requestUrlFor(row.feed)).host;
    } catch (err) {
      host = "";
    }
    return withHost(host, async () => ({
      index: row.index,
      result: await fetchOne(row.feed, opts),
    }));
  });
  return results;
}

function requestUrlFor(feed) {
  if (isArcticShift(feed)) return arcticEndpoint(feed);
  return feed.feed_url || "";
}

export async function fetchOne(feed, opts = {}) {
  const fetchedAt = new Date().toISOString();
  const base = {
    name: feed.name,
    site_url: feed.site_url || "",
    feed_url: feed.feed_url || "",
    category: feed.category,
    priority: feed.priority || "normal",
    status: feed.status || "",
    intake: isArcticShift(feed) ? "arctic-shift" : "rss",
    subreddit: arcticSubreddit(feed),
    ok: false,
    error: null,
    fetchedAt,
    lastOkAt: null,
    retained: false,
    items: [],
  };
  if (isArcticShift(feed)) return fetchArctic(feed, base, opts);
  if (isReddit(feed.feed_url)) return { ...base, error: "reddit rss disabled" };
  return fetchRss(feed, base, opts);
}

async function fetchRss(feed, base, opts) {
  const fetchImpl = opts.fetch || fetch;
  const timeoutMs = opts.timeoutMs || 8000;
  const attempts = 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetchImpl(feed.feed_url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 && attempt < attempts - 1) {
        await cancelBody(res);
        const delay = opts.retryDelayMs == null ? 600 : opts.retryDelayMs;
        await sleep(delay);
        continue;
      }
      if (!res.ok) {
        await cancelBody(res);
        return { ...base, error: "HTTP " + res.status };
      }
      const xml = await readText(res, MAX_BYTES);
      const parsed = parseFeed(xml, feed.feed_url);
      if (!parsed.ok) return { ...base, error: parsed.error || "not a feed" };
      return {
        ...base,
        ok: true,
        error: null,
        lastOkAt: base.fetchedAt,
        items: parsed.items,
      };
    } catch (err) {
      return { ...base, error: fetchError(err) };
    }
  }
  return { ...base, error: "HTTP 429" };
}

async function fetchArctic(feed, base, opts) {
  const fetchImpl = opts.fetch || fetch;
  const timeoutMs = opts.timeoutMs || 8000;
  const sub = arcticSubreddit(feed);
  if (!sub) return { ...base, error: "missing subreddit" };
  const nowSec = opts.nowSec || Math.floor(Date.now() / 1000);
  let limit = Number(feed.arctic && feed.arctic.limit) || ARCTIC_LIMIT;
  let narrowed = false;
  let rateRetries = 0;
  const maxRateRetries = opts.rateRetries == null ? 1 : opts.rateRetries;
  for (let attempt = 0; attempt < 5; attempt++) {
    const url = arcticSearchUrl(feed, limit, nowSec);
    if (/[?&]fields=[^&]*permalink/i.test(url) || /[?&]permalink=/i.test(url)) {
      return { ...base, error: "bad arctic query" };
    }
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 422 && !narrowed) {
        await cancelBody(res);
        limit = ARCTIC_RETRY_LIMIT;
        narrowed = true;
        continue;
      }
      if (res.status === 429 && rateRetries < maxRateRetries) {
        await cancelBody(res);
        rateRetries += 1;
        const delay = opts.retryDelayMs == null ? 1500 : opts.retryDelayMs;
        await sleep(delay);
        continue;
      }
      if (!res.ok) {
        await cancelBody(res);
        return { ...base, error: "HTTP " + res.status };
      }
      const text = await readText(res, MAX_BYTES);
      const parsed = parseArctic(text, feed, nowSec);
      if (!parsed.ok) return { ...base, error: parsed.error || "not a feed" };
      return {
        ...base,
        ok: true,
        error: null,
        lastOkAt: base.fetchedAt,
        items: parsed.items,
      };
    } catch (err) {
      return { ...base, error: fetchError(err) };
    }
  }
  return { ...base, error: "HTTP 422" };
}

function fetchError(err) {
  const name = err && err.name ? err.name : "";
  const message = String((err && err.message) || err || "");
  if (name === "TimeoutError" || name === "AbortError" || /timeout/i.test(message)) return "timeout";
  return "network error";
}

function arcticEndpoint(feed) {
  const raw = (feed.arctic && feed.arctic.endpoint) || ARCTIC_ENDPOINT;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return ARCTIC_ENDPOINT;
    return url.origin + url.pathname;
  } catch (err) {
    return ARCTIC_ENDPOINT;
  }
}

function arcticFields(feed) {
  const raw = (feed.arctic && feed.arctic.fields) || ARCTIC_FIELDS;
  const allowed = new Set(ARCTIC_FIELDS.split(","));
  const picked = String(raw)
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && part !== "permalink" && allowed.has(part));
  return picked.length ? picked.join(",") : ARCTIC_FIELDS;
}

function arcticWindowHours(feed) {
  const raw = feed.arctic && feed.arctic.after;
  if (raw == null || raw === "") return ARCTIC_WINDOW_HOURS;
  const text = String(raw).trim();
  const hours = text.match(/^(\d+)\s*h$/i);
  if (hours) return Number(hours[1]);
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && asNumber > 0 && asNumber < 24 * 60) return asNumber;
  return ARCTIC_WINDOW_HOURS;
}

export function arcticSearchUrl(feed, limit, nowSec) {
  const after = nowSec - arcticWindowHours(feed) * 3600;
  const url = new URL(arcticEndpoint(feed));
  url.searchParams.set("subreddit", arcticSubreddit(feed));
  url.searchParams.set("after", String(after));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("fields", arcticFields(feed));
  return url.href;
}

export function parseArctic(jsonText, feed, nowSec) {
  let body;
  try {
    body = JSON.parse(String(jsonText || ""));
  } catch (err) {
    return { ok: false, error: "not a feed", items: [] };
  }
  const rows = Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : null;
  if (!rows) return { ok: false, error: "not a feed", items: [] };
  const minScore =
    feed.arctic && feed.arctic.min_score != null && feed.arctic.min_score !== ""
      ? Number(feed.arctic.min_score)
      : 0;
  const ageHours =
    feed.arctic && feed.arctic.min_score_age_hours != null
      ? Number(feed.arctic.min_score_age_hours)
      : 36;
  const ageSec = (Number.isFinite(ageHours) ? ageHours : 36) * 3600;
  const floor = Number.isFinite(minScore) ? minScore : 0;
  const subFallback = arcticSubreddit(feed);
  const scored = [];
  const fresh = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id || "").trim();
    if (!/^[a-z0-9]+$/i.test(id) || seen.has(id)) continue;
    const title = cleanText(row.title || "");
    if (!title || title === "[deleted]" || title === "[removed]") continue;
    const created = Number(row.created_utc);
    const hasDate = Number.isFinite(created);
    const age = hasDate ? nowSec - created : Infinity;
    const scoreNum = Number(row.score);
    const score = Number.isFinite(scoreNum) ? scoreNum : 0;
    const young = hasDate && age < ageSec;
    const passes = score >= floor;
    if (!passes && !young) continue;
    const fromPost = String(row.subreddit || "");
    const sub = /^[A-Za-z0-9_]{2,30}$/.test(fromPost) ? fromPost : subFallback;
    if (!sub) continue;
    seen.add(id);
    const item = {
      title: title.length > 240 ? clip(title, 240) : title,
      url: "https://www.reddit.com/r/" + sub + "/comments/" + id + "/",
      date: hasDate ? new Date(created * 1000).toISOString() : null,
      excerpt: excerptFromSelftext(row.selftext),
    };
    if (passes) scored.push(item);
    else fresh.push(item);
  }
  scored.sort(compareItems);
  fresh.sort(compareItems);
  const items = scored.concat(fresh.slice(0, FRESH_SCORE_CAP)).sort(compareItems).slice(0, KEEP_ITEMS);
  return { ok: true, error: null, items };
}

function excerptFromSelftext(raw) {
  const plain = tidyExcerpt(cleanText(String(raw || "")).slice(0, 8000));
  if (plain.length < 20) return "";
  return clip(plain, 300);
}

export function parseFeed(xml, base) {
  const text = String(xml || "").replace(/^\uFEFF/, "");
  if (!isFeedDocument(text)) return { ok: false, error: "not a feed", items: [] };
  const entries = extractBlocks(text, "entry");
  const blocks = entries.length ? entries : extractBlocks(text, "item");
  const items = [];
  const seen = new Set();
  for (const block of blocks) {
    const item = parseItem(block, base);
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    items.push(item);
    if (items.length >= PARSE_ITEMS) break;
  }
  items.sort(compareItems);
  return { ok: true, error: null, items: items.slice(0, KEEP_ITEMS) };
}

function parseItem(block, base) {
  const titleEl = walkElements(block, "title", 1)[0];
  const plainTitle = toPlain(titleEl ? titleEl.text : "");
  if (!plainTitle) return null;
  const url = pickLink(block, base);
  if (!url) return null;
  return {
    title: plainTitle.length > 240 ? clip(plainTitle, 240) : plainTitle,
    url,
    date: parseDate(block),
    excerpt: excerptFrom(block),
  };
}

function pickLink(block, base) {
  const links = walkElements(block, "link", 12);
  let best = "";
  let bestScore = -1;
  for (const link of links) {
    const href = attr(link.attrs, "href") || toPlain(link.text);
    const url = safeUrl(href, base);
    if (!url) continue;
    const rel = attr(link.attrs, "rel").toLowerCase();
    let score = 1;
    if (!rel || rel === "alternate") score += 5;
    if (rel.includes("self") || rel.includes("replies") || rel.includes("enclosure")) score -= 4;
    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }
  if (best) return best;
  const guid = walkElements(block, "guid", 1)[0];
  if (!guid) return "";
  if (attr(guid.attrs, "ispermalink").toLowerCase() === "false") return "";
  return safeUrl(toPlain(guid.text), base);
}

function parseDate(block) {
  for (const name of ["published", "pubdate", "date", "updated", "modified"]) {
    const el = walkElements(block, name, 1)[0];
    if (!el) continue;
    const raw = toPlain(el.text);
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function excerptFrom(block) {
  for (const name of ["summary", "description", "encoded", "content"]) {
    const el = walkElements(block, name, 1)[0];
    if (!el) continue;
    const plain = tidyExcerpt(toPlain(el.text.slice(0, 8000)));
    if (plain.length >= 20) return clip(plain, 300);
  }
  return "";
}

export function sectionItems(feeds, category, opts = {}) {
  const low = !!opts.low;
  function gather(perSource) {
    const pool = [];
    for (const feed of feeds || []) {
      if (feed.category !== category) continue;
      if (isLowPriority(feed) !== low) continue;
      const items = prepareFeedItems(feed).slice(0, perSource);
      for (const item of items) {
        pool.push({
          ...item,
          source: feed.name,
          feed_url: feed.feed_url,
        });
      }
    }
    pool.sort(compareItems);
    return dedupeItems(pool);
  }
  let picked = gather(3);
  if (picked.length < 8) picked = gather(6);
  if (picked.length < 8) picked = gather(KEEP_ITEMS);
  return picked.slice(0, SECTION_LIMIT);
}

export function prepareFeedItems(feed) {
  const items = (feed && feed.items) || [];
  const kept = [];
  const held = [];
  for (const item of items) {
    if (noisyTitle(feed.feed_url || "", item.title || "")) held.push(item);
    else kept.push(item);
  }
  const usable = kept.length
    ? kept
    : held.filter((item) => !/\brevoked\b/i.test(item.title || ""));
  if (!(feed.feed_url || "").includes("releases.atom")) return usable;
  return usable.map((item) => ({ ...item, excerpt: "" }));
}

export function noisyTitle(feedUrl, title) {
  if (/\(revoked\)|\brevoked\b/i.test(title)) return true;
  if (String(feedUrl).includes("meshtastic/firmware") && /\balpha\b/i.test(title)) return true;
  if (String(feedUrl).includes("chirpstack/chirpstack") && /-test\./i.test(title)) return true;
  if (String(feedUrl).includes("connectedhomeip") && /-te\d/i.test(title)) return true;
  return false;
}

export function dedupeItems(items) {
  const kept = [];
  for (const item of items) {
    const idx = kept.findIndex(
      (current) => current.url === item.url || nearDuplicate(current, item)
    );
    if (idx === -1) {
      kept.push(item);
      continue;
    }
    if (isReleaseFeed(kept[idx]) && !isReleaseFeed(item)) kept[idx] = item;
  }
  return kept;
}

function isReleaseFeed(item) {
  const url = item.url || "";
  const feedUrl = item.feed_url || "";
  return /github\.com\/[^/]+\/[^/]+\/releases/i.test(url) || feedUrl.includes("releases.atom");
}

export function nearDuplicate(a, b) {
  const na = normTitle(a.title);
  const nb = normTitle(b.title);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  const shortKey = shorter.replace(/^v(?=\d)/, "");
  const contained = longer.includes(shorter) || (shortKey !== shorter && longer.includes(shortKey));
  if (!contained) return false;
  if (isVersionTitle(shorter) && shortKey.length >= 5) return true;
  if (shorter.length < 8) return false;
  return shorter.length / longer.length >= 0.72;
}

export function normTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isVersionTitle(norm) {
  const raw = norm.replace(/^v(?=\d)/, "").trim();
  if (!/^\d/.test(raw)) return false;
  const parts = raw.split(" ").filter(Boolean);
  if (parts.some((part) => !/^\d+$/.test(part) && !/^b\d+$/.test(part) && !/^rc\d+$/.test(part))) {
    return false;
  }
  if (parts[0].length >= 4) return true;
  return parts.length >= 3;
}

export function renderFeedsPage(catalog, aggregate) {
  const feeds = aggregate.feeds || [];
  const categories = categoriesOf(catalog, feeds);
  const refreshed = formatAst(aggregate.refreshedAt, true);
  const staleNote = aggregate.stale
    ? " A newer check failed, so this is the last good copy."
    : "";
  const sections = categories
    .map((category) =>
      renderSection(
        category,
        sectionItems(feeds, category),
        sectionItems(feeds, category, { low: true })
      )
    )
    .join("");
  const sources = categories
    .map((category) => {
      const rows = feeds.filter((feed) => feed.category === category);
      if (!rows.length) return "";
      return (
        "<h3 class=\"source-cat\">" +
        esc(category) +
        "</h3><ul class=\"sources\">" +
        rows.map(renderSource).join("") +
        "</ul>"
      );
    })
    .join("");

  return (
    "<!DOCTYPE html>\n" +
    "<html lang=\"en\">\n" +
    "<head>\n" +
    "  <meta charset=\"utf-8\">\n" +
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n" +
    "  <title>Feeds — HA News</title>\n" +
    "  <meta name=\"description\" content=\"Headlines from the Home Assistant, Matter, OpenWrt, ESPHome, LoRaWAN, and smart-home sources HA News follows. Links go to the original. Excerpts are at most 300 characters.\">\n" +
    "  <link rel=\"canonical\" href=\"https://hanews.org/feeds\">\n" +
    "  <link rel=\"alternate\" type=\"text/x-opml\" title=\"HA News feeds\" href=\"https://hanews.org/feeds.opml\">\n" +
    "  <meta name=\"robots\" content=\"index, follow\">\n" +
    "  <link rel=\"stylesheet\" href=\"/styles.css\">\n" +
    "  <script src=\"/ga.js\" defer></script>\n" +
    "  <script src=\"https://challenges.cloudflare.com/turnstile/v0/api.js\" async defer></script>\n" +
    "</head>\n" +
    "<body>\n" +
    "  <a class=\"skip\" href=\"#main\">Skip to content</a>\n" +
    "  <div class=\"topbar\" aria-hidden=\"true\"></div>\n" +
    "  <header class=\"masthead\">\n" +
    "    <div class=\"masthead__meta\">\n" +
    "      <span class=\"dateline\">" +
    esc(formatDateline(new Date())) +
    "</span>\n" +
    "      <div class=\"masthead__aside\">\n" +
    "        <span class=\"masthead__edition\">Home automation edition</span>\n" +
    "        <button type=\"button\" class=\"signup-trigger\">Get the briefing</button>\n" +
    "      </div>\n" +
    "    </div>\n" +
    "    <a class=\"masthead__brand\" href=\"/\" aria-label=\"Home Assistant News home\">Home Assistant News</a>\n" +
    "    <p class=\"masthead__tagline\">Reporting the local stack, from radio to automations.</p>\n" +
    "  </header>\n" +
    "  <nav class=\"sectionnav\" aria-label=\"Sections\">\n" +
    "    <div class=\"sectionnav__inner\">\n" +
    "      <a href=\"/\" class=\"sectionnav__home\">HOME</a>\n" +
    "      <a href=\"/ha\">HOME ASSISTANT</a>\n" +
    "      <a href=\"/matter\">MATTER &amp; THREAD</a>\n" +
    "      <a href=\"/esphome\">ESPHOME</a>\n" +
    "      <a href=\"/devices\">DEVICES</a>\n" +
    "      <a href=\"/energy\">ENERGY</a>\n" +
    "      <a href=\"/explainers\">EXPLAINERS</a>\n" +
    "      <a href=\"/feeds\" aria-current=\"page\">FEEDS</a>\n" +
    "      <a href=\"/about\">ABOUT</a>\n" +
    "    </div>\n" +
    "  </nav>\n" +
    "  <main id=\"main\" class=\"page\">\n" +
    "    <div class=\"sheet\">\n" +
    "      <div class=\"page-inner wide\">\n" +
    "        <p class=\"kicker\">Outside sources</p>\n" +
    "        <h1>Feeds</h1>\n" +
    "        <p class=\"lede\">Headlines from the local-stack sources we follow. Every link goes to the original article. We show a short excerpt, at most 300 characters, not the full text. Release notes and industry posts are folded at the bottom of each section.</p>\n" +
    "        <p class=\"feed-refresh\">Updated hourly. Last refresh: " +
    esc(refreshed) +
    "." +
    esc(staleNote) +
    " <a href=\"/feeds.opml\">OPML</a></p>\n" +
    sections +
    "        <section class=\"sources-block\" aria-labelledby=\"sources-h\">\n" +
    "          <h2 class=\"kicker\" id=\"sources-h\">Sources</h2>\n" +
    "          <p class=\"feed-note\">The same list a feed reader can import. Each line is the site, the feed, and the last successful check or the error.</p>\n" +
    sources +
    "        </section>\n" +
    "      </div>\n" +
    "    </div>\n" +
    "  </main>\n" +
    "  <footer class=\"foot\">\n" +
    "    <div class=\"sheet foot-inner\">\n" +
    "      <span>HA News</span>\n" +
    "      <span class=\"sep\" aria-hidden=\"true\">·</span>\n" +
    "      <a href=\"https://github.com/adamb/hanews\">Pipeline on GitHub</a>\n" +
    "      <span class=\"sep\" aria-hidden=\"true\">·</span>\n" +
    "      <span>Published weekdays · Review welcome</span>\n" +
    "      <span class=\"sep\" aria-hidden=\"true\">·</span>\n" +
    "      <span>© 2026</span>\n" +
    "      <span class=\"sep\" aria-hidden=\"true\">·</span>\n" +
    "      <a href=\"/advertise\">Advertise</a>\n" +
    "      <p class=\"host\">Hosted target: Cloudflare Pages.</p>\n" +
    "    </div>\n" +
    "  </footer>\n" +
    signupDialog() +
    "  <script src=\"/subscribe.js\"></script>\n" +
    "</body>\n" +
    "</html>\n"
  );
}

function renderSection(category, items, shelfItems) {
  const id = slug(category);
  const shelf = shelfItems || [];
  let body = "";
  if (!items.length && !shelf.length) {
    body = "<p class=\"feed-empty\">No items from these sources on the last check.</p>";
  } else if (items.length) {
    body = "<ul class=\"feed-list\">" + items.map(renderItem).join("") + "</ul>";
  }
  const folded = shelf.length
    ? "<details class=\"feed-shelf\"><summary>Release notes &amp; industry</summary><ul class=\"feed-list\">" +
      shelf.map(renderItem).join("") +
      "</ul></details>"
    : "";
  return (
    "<section aria-labelledby=\"" +
    esc(id) +
    "\">" +
    "<h2 class=\"kicker\" id=\"" +
    esc(id) +
    "\">" +
    esc(category) +
    "</h2>" +
    body +
    folded +
    "</section>"
  );
}

function renderItem(item) {
  const when = item.date ? formatAst(item.date, false) : "Seen";
  const excerpt = item.excerpt
    ? "<p class=\"feed-excerpt\">" + esc(item.excerpt) + "</p>"
    : "";
  return (
    "<li><a class=\"feed-title\" href=\"" +
    esc(item.url) +
    "\" rel=\"noopener noreferrer\">" +
    esc(item.title) +
    "</a><p class=\"feed-meta\">" +
    esc(item.source || "") +
    " · " +
    esc(when) +
    "</p>" +
    excerpt +
    "</li>"
  );
}

function renderSource(feed) {
  const site = safeUrl(feed.site_url);
  const feedUrl = safeUrl(readerFeedUrl(feed));
  const name = site
    ? "<a href=\"" + esc(site) + "\" rel=\"noopener noreferrer\">" + esc(feed.name) + "</a>"
    : esc(feed.name);
  const feedLink = feedUrl
    ? "<a href=\"" + esc(feedUrl) + "\" rel=\"noopener noreferrer\">feed</a>"
    : "feed";
  const via =
    feed.intake === "arctic-shift"
      ? " <span class=\"sep\" aria-hidden=\"true\">·</span> Arctic Shift"
      : "";
  return (
    "<li>" +
    name +
    " <span class=\"sep\" aria-hidden=\"true\">·</span> " +
    feedLink +
    via +
    " <span class=\"sep\" aria-hidden=\"true\">·</span> " +
    esc(sourceStatus(feed)) +
    "</li>"
  );
}

function readerFeedUrl(feed) {
  if (feed && feed.intake === "arctic-shift" && feed.subreddit) {
    return "https://www.reddit.com/r/" + feed.subreddit + "/.rss";
  }
  return (feed && feed.feed_url) || "";
}

function sourceStatus(feed) {
  if (feed.ok && feed.items && feed.items.length) {
    return "Last ok " + formatAst(feed.lastOkAt || feed.fetchedAt, true);
  }
  if (feed.ok) return "Last ok " + formatAst(feed.fetchedAt, true) + " · no items";
  const err = feed.error || "error";
  if (feed.retained && feed.lastOkAt) {
    return err + " · showing items from " + formatAst(feed.lastOkAt, true);
  }
  return err;
}

export function renderFeedsJson(catalog, aggregate) {
  const feeds = aggregate.feeds || [];
  return {
    refreshedAt: aggregate.refreshedAt,
    stale: !!aggregate.stale,
    timezone: AST,
    categories: categoriesOf(catalog, feeds).map((name) => ({
      name,
      items: sectionItems(feeds, name).map(publicItem),
      release_notes: sectionItems(feeds, name, { low: true }).map(publicItem),
    })),
    sources: feeds.map((feed) => ({
      name: feed.name,
      category: feed.category,
      site_url: feed.site_url,
      feed_url: feed.feed_url,
      ok: !!feed.ok,
      error: feed.ok ? null : feed.error || "error",
      lastOkAt: feed.lastOkAt,
      retained: !!feed.retained,
      items: (feed.items || []).length,
    })),
  };
}

function publicItem(item) {
  return {
    title: item.title,
    url: item.url,
    source: item.source,
    date: item.date,
    excerpt: item.excerpt || "",
  };
}

export function opmlTarget(feed) {
  if (isArcticShift(feed)) {
    const sub = arcticSubreddit(feed);
    return {
      xmlUrl: "https://www.reddit.com/r/" + sub + "/.rss",
      htmlUrl: feed.site_url || "https://www.reddit.com/r/" + sub + "/",
      description:
        "HA News reads this subreddit through Arctic Shift, not Reddit RSS. This link is the public Reddit feed for readers.",
    };
  }
  return {
    xmlUrl: feed.feed_url,
    htmlUrl: feed.site_url || "",
    description: "",
  };
}

export function renderOpml(catalog) {
  const feeds = activeFeeds(catalog);
  const groups = categoriesOf(catalog, feeds)
    .map((category) => {
      const outlines = feeds
        .filter((feed) => feed.category === category)
        .map((feed) => {
          const target = opmlTarget(feed);
          const description = target.description
            ? " description=\"" + esc(target.description) + "\""
            : "";
          return (
            "      <outline type=\"rss\" text=\"" +
            esc(feed.name) +
            "\" title=\"" +
            esc(feed.name) +
            "\" xmlUrl=\"" +
            esc(target.xmlUrl) +
            "\" htmlUrl=\"" +
            esc(target.htmlUrl) +
            "\"" +
            description +
            "/>"
          );
        })
        .join("\n");
      return (
        "    <outline text=\"" +
        esc(category) +
        "\" title=\"" +
        esc(category) +
        "\">\n" +
        outlines +
        "\n    </outline>"
      );
    })
    .join("\n");
  return (
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<opml version=\"2.0\">\n" +
    "  <head>\n" +
    "    <title>HA News feeds</title>\n" +
    "    <ownerName>HA News</ownerName>\n" +
    "    <docs>https://hanews.org/feeds</docs>\n" +
    "  </head>\n" +
    "  <body>\n" +
    groups +
    "\n  </body>\n" +
    "</opml>\n"
  );
}

export function finish(request, body, contentType, cacheControl, cacheState) {
  const headers = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "CDN-Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    "X-Feeds-Cache": cacheState || "static",
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(body, { status: 200, headers });
}

export function methodNotAllowed() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
  });
}

export function formatAst(iso, withYear) {
  if (!iso) return "Seen";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Seen";
  const options = {
    timeZone: AST,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  if (withYear !== false) options.year = "numeric";
  const formatted = new Intl.DateTimeFormat("en-US", options)
    .format(date)
    .replace(/[\u202f\u00a0]/g, " ");
  return formatted + " AST";
}

export function formatDateline(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: AST,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === '"') return "&quot;";
    return "&#39;";
  });
}

function signupDialog() {
  return (
    "  <dialog class=\"signup-modal\" aria-labelledby=\"signup-modal-title\">\n" +
    "    <form class=\"signup-modal__close\" method=\"dialog\">\n" +
    "      <div class=\"cf-turnstile\" data-sitekey=\"0x4AAAAAAFXNHNNq9PO5vjk5\" data-appearance=\"interaction-only\"></div>\n" +
    "      <button type=\"submit\" aria-label=\"Close\">×</button>\n" +
    "    </form>\n" +
    "    <form class=\"signup-modal__body sub-form\" action=\"/subscribe\" method=\"post\">\n" +
    "      <p class=\"signup-modal__kicker\">The Briefing</p>\n" +
    "      <h2 id=\"signup-modal-title\" class=\"signup-modal__title\">Get the HA briefing in your inbox</h2>\n" +
    "      <p class=\"signup-modal__text\">Home Assistant, Matter, Thread, ESPHome and local-first devices — the daily brief, with signal and primary sources.</p>\n" +
    "      <label class=\"signup-modal__field\">\n" +
    "        <span>Name</span>\n" +
    "        <input type=\"text\" name=\"name\" required autocomplete=\"name\" maxlength=\"80\" placeholder=\"Name\">\n" +
    "      </label>\n" +
    "      <label class=\"signup-modal__field\">\n" +
    "        <span>Email</span>\n" +
    "        <input type=\"email\" name=\"email\" required autocomplete=\"email\" placeholder=\"you@example.com\">\n" +
    "      </label>\n" +
    "      <label class=\"signup-modal__field\">\n" +
    "        <span>Phone</span>\n" +
    "      </label>\n" +
    "      <div class=\"cf-turnstile\" data-sitekey=\"0x4AAAAAAFXNHNNq9PO5vjk5\" data-appearance=\"interaction-only\"></div>\n" +
    "      <button type=\"submit\" class=\"signup-modal__submit\">Subscribe</button>\n" +
    "      <p class=\"signup-modal__fine\">We'll email a confirm link. Unsubscribe anytime.</p>\n" +
    "      <p class=\"sub-status\" role=\"status\"></p>\n" +
    "    </form>\n" +
    "  </dialog>\n"
  );
}

function slug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function compareItems(a, b) {
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.date && !b.date) return -1;
  if (!a.date && b.date) return 1;
  return 0;
}

function isFeedDocument(xml) {
  const head = xml.slice(0, 8000).toLowerCase();
  return head.includes("<rss") || head.includes("<feed") || head.includes("<rdf");
}

function extractBlocks(xml, tag) {
  const blocks = [];
  const closeToken = "</" + tag + ">";
  let from = 0;
  while (blocks.length < 20) {
    const start = indexOfTag(xml, tag, from);
    if (start === -1) break;
    const end = indexOfOutsideCdata(xml, closeToken, start, true);
    if (end === -1) break;
    blocks.push(xml.slice(start, end + closeToken.length));
    from = end + closeToken.length;
  }
  return blocks;
}

function indexOfTag(xml, tag, from) {
  const needle = "<" + tag;
  let pos = from;
  while (pos < xml.length) {
    const start = indexOfOutsideCdata(xml, needle, pos, true);
    if (start === -1) return -1;
    const next = xml[start + needle.length];
    if (next === ">" || next === "/" || /\s/.test(next || "")) return start;
    pos = start + needle.length;
  }
  return -1;
}

function indexOfOutsideCdata(xml, token, from, caseInsensitive) {
  const hay = caseInsensitive ? xml.toLowerCase() : xml;
  const needle = caseInsensitive ? token.toLowerCase() : token;
  let pos = from;
  while (pos < xml.length) {
    const cdata = xml.indexOf("<![CDATA[", pos);
    const found = hay.indexOf(needle, pos);
    if (found === -1) return -1;
    if (cdata !== -1 && cdata < found) {
      const end = xml.indexOf("]]>", cdata + 9);
      if (end === -1) return -1;
      pos = end + 3;
      continue;
    }
    return found;
  }
  return -1;
}

function walkElements(xml, localName, limit) {
  const want = localName.toLowerCase();
  const found = [];
  const max = limit || 40;
  let i = 0;
  while (i < xml.length && found.length < max) {
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml[i] !== "<" || xml[i + 1] === "/" || xml[i + 1] === "?" || xml[i + 1] === "!") {
      i += 1;
      continue;
    }
    const nameStart = i + 1;
    let j = nameStart;
    while (j < xml.length && /[A-Za-z0-9_.:-]/.test(xml[j])) j += 1;
    const full = xml.slice(nameStart, j);
    const local = (full.includes(":") ? full.slice(full.lastIndexOf(":") + 1) : full).toLowerCase();
    const gt = xml.indexOf(">", j);
    if (gt === -1) break;
    const openTag = xml.slice(i, gt + 1);
    if (local !== want) {
      i = gt + 1;
      continue;
    }
    if (xml[gt - 1] === "/") {
      found.push({ attrs: openTag, text: "" });
      i = gt + 1;
      continue;
    }
    const close = "</" + full + ">";
    const end = indexOfOutsideCdata(xml, close, gt + 1, true);
    if (end === -1) break;
    found.push({ attrs: openTag, text: xml.slice(gt + 1, end) });
    i = end + close.length;
  }
  return found;
}

function attr(tag, name) {
  const re = new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "i");
  const match = String(tag || "").match(re);
  if (!match) return "";
  return decodeXml(match[2] != null ? match[2] : match[3] || "");
}

function toPlain(raw) {
  let text = unwrapCdata(String(raw || ""));
  text = decodeXml(text);
  if (text.includes("&lt;") || text.includes("&amp;") || text.includes("&#")) text = decodeXml(text);
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeXml(text);
  return cleanText(text);
}

function tidyExcerpt(text) {
  let cleaned = text
    .replace(/\bRead full topic\b\.?/gi, " ")
    .replace(/\b\d+\s+posts?\s+-\s+\d+\s+participants?\b/gi, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s*submitted by\s+\/?u\/\S+[\s\S]*$/i, " ")
    .replace(/\[link\]|\[comments\]/gi, " ");
  cleaned = cleanText(cleaned);
  if (/^submitted by\b/i.test(cleaned) || cleaned.length < 20) return "";
  return cleaned;
}

function isReddit(url) {
  try {
    return isRedditHost(new URL(url).host);
  } catch (err) {
    return false;
  }
}

function isRedditHost(host) {
  return host === "reddit.com" || host === "www.reddit.com" || String(host || "").endsWith(".reddit.com");
}

function unwrapCdata(text) {
  const wrapped = text.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (wrapped) return wrapped[1];
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function decodeXml(text) {
  return String(text).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, ent) => {
    if (ent === "amp") return "&";
    if (ent === "lt") return "<";
    if (ent === "gt") return ">";
    if (ent === "quot") return "\"";
    if (ent === "apos") return "'";
    const code =
      ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all;
    try {
      return String.fromCodePoint(code);
    } catch (err) {
      return all;
    }
  });
}

function cleanText(text) {
  return String(text || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text, max) {
  if (!text || text.length <= max) return text || "";
  let cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  if (space >= max - 80) cut = cut.slice(0, space);
  cut = cut.replace(/[.,;:!\-–—\s]+$/, "");
  if (cut.length > max - 1) cut = cut.slice(0, max - 1).replace(/[.,;:!\-–—\s]+$/, "");
  return cut + "…";
}

function safeUrl(value, base) {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.href;
  } catch (err) {
    return "";
  }
}

function ageMs(iso) {
  const ms = Date.parse(iso || "");
  if (Number.isNaN(ms)) return Infinity;
  return Date.now() - ms;
}

function cacheStore() {
  try {
    if (typeof caches === "undefined" || !caches || !caches.default) return null;
    return caches.default;
  } catch (err) {
    return null;
  }
}

async function readStored() {
  const cache = cacheStore();
  if (!cache) return null;
  try {
    const hit = await cache.match(new Request(CACHE_URL));
    if (!hit) return null;
    return await hit.json();
  } catch (err) {
    return null;
  }
}

async function writeStored(aggregate) {
  const cache = cacheStore();
  if (!cache) return;
  try {
    await cache.put(
      new Request(CACHE_URL),
      new Response(JSON.stringify(aggregate), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      })
    );
  } catch (err) {
    console.log("feeds cache put failed");
  }
}

async function readText(response, maxBytes) {
  if (!response.body || !response.body.getReader) {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.byteLength) continue;
      const room = maxBytes - received;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        received += room;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch (err) {
      /* already consumed */
    }
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

async function cancelBody(response) {
  try {
    if (response.body && response.body.cancel) await response.body.cancel();
  } catch (err) {
    /* ignore */
  }
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Math.min(limit, items.length) || 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return out;
}
