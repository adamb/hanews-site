import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HOUR_CACHE,
  USER_AGENT,
  activeFeeds,
  cacheControlFor,
  categoriesOf,
  dedupeItems,
  fetchOne,
  formatAst,
  mergeResults,
  nearDuplicate,
  parseFeed,
  prepareFeedItems,
  refreshFeeds,
  renderFeedsPage,
  renderOpml,
  sectionItems,
} from "../functions/_feeds.js";

const catalog = JSON.parse(
  readFileSync(new URL("../data/feeds.json", import.meta.url), "utf8")
);

const RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example</title>
    <item>
      <title><![CDATA[OpenWrt &amp; friends]]></title>
      <link>https://example.com/one</link>
      <pubDate>Wed, 21 Oct 2026 09:50:17 +0000</pubDate>
      <description><![CDATA[<p>Patches landed &amp; the site is back. <script>alert(1)</script></p>
        <p><small>11 posts - 9 participants</small></p>
        <p><a href="https://example.com/one">Read full topic</a></p>]]></description>
      <guid isPermaLink="false">not-a-url</guid>
    </item>
    <item>
      <title>Skip me</title>
      <link>javascript:alert(1)</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Blog</title>
  <link href="https://example.com/atom.xml" rel="self"/>
  <entry>
    <title type="html"><![CDATA[No device left behind]]></title>
    <link href="/blog/aux-2/"/>
    <updated>2026-11-11T00:00:01+00:00</updated>
    <content type="html"><![CDATA[<p>${"Word ".repeat(80)}</p>]]></content>
  </entry>
  <entry>
    <link rel="self" href="https://example.com/atom.xml"/>
    <link rel="alternate" type="text/html" href="https://example.com/real"/>
    <title>Alternate wins</title>
    <published>2026-11-01T15:00:00Z</published>
    <summary type="html"><![CDATA[A short summary that is definitely long enough to keep.]]></summary>
  </entry>
</feed>`;

test("catalog keeps the 40 vetted feeds and ignores dropped", () => {
  const feeds = activeFeeds(catalog);
  assert.equal(feeds.length, 40);
  assert.deepEqual(categoriesOf(catalog, feeds), [
    "Home Assistant",
    "Matter & Thread",
    "OpenWrt & networking",
    "ESPHome & DIY",
    "LoRaWAN & mesh radio",
    "Smart home news",
  ]);
  assert.equal(feeds.some((feed) => feed.feed_url.includes("latest.rss")), false);
  assert.equal(feeds.some((feed) => /stacey/i.test(feed.name)), false);
  const opml = renderOpml(catalog);
  assert.equal((opml.match(/xmlUrl="/g) || []).length, 40);
  assert.equal(opml.includes("staceyoniot.com"), false);
  assert.equal(opml.includes("forum.openwrt.org/c/announcements/14.rss"), true);
});

test("parses RSS and Atom, strips markup, and rejects javascript urls", () => {
  const rss = parseFeed(RSS);
  assert.equal(rss.ok, true);
  assert.equal(rss.items.length, 1);
  assert.equal(rss.items[0].title, "OpenWrt & friends");
  assert.equal(rss.items[0].url, "https://example.com/one");
  assert.equal(rss.items[0].date, "2026-10-21T09:50:17.000Z");
  assert.ok(rss.items[0].excerpt.includes("Patches landed & the site is back"));
  assert.equal(rss.items[0].excerpt.includes("Read full topic"), false);
  assert.equal(rss.items[0].excerpt.includes("<script>"), false);
  assert.ok(rss.items[0].excerpt.length <= 300);

  const atom = parseFeed(ATOM, "https://example.com/atom.xml");
  assert.equal(atom.items.length, 2);
  assert.equal(atom.items[0].title, "No device left behind");
  assert.equal(atom.items[0].url, "https://example.com/blog/aux-2/");
  assert.equal(atom.items[0].date, "2026-11-11T00:00:01.000Z");
  assert.ok(atom.items[0].excerpt.length <= 300);
  assert.ok(atom.items[0].excerpt.endsWith("…"));
  assert.equal(atom.items[1].url, "https://example.com/real");
});

test("HTML challenge pages are not feeds", () => {
  const parsed = parseFeed("<!DOCTYPE html><html><title>Just a moment</title></html>");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, "not a feed");
});

test("AST timestamps use America/Puerto_Rico", () => {
  assert.equal(formatAst("2026-11-16T06:40:00Z", true), "Nov 16, 2026, 2:40 AM AST");
  assert.equal(formatAst("2026-11-16T06:40:00Z", false), "Nov 16, 2:40 AM AST");
  assert.equal(formatAst(null, true), "Seen");
});

test("dedupes a release tag against its blog post and keeps distinct headlines", () => {
  const github = {
    title: "2026.11.1",
    url: "https://github.com/home-assistant/core/releases/tag/2026.11.1",
    feed_url: "https://github.com/home-assistant/core/releases.atom",
    date: "2026-11-09T18:52:28.000Z",
  };
  const blog = {
    title: "2026.11.1",
    url: "https://www.home-assistant.io/blog/2026/11/09/release/",
    feed_url: "https://www.home-assistant.io/atom.xml",
    date: "2026-11-09T18:00:00.000Z",
  };
  const other = {
    title: "No device left behind: Home Assistant Connect AUX-2",
    url: "https://www.home-assistant.io/blog/aux",
    feed_url: "https://www.home-assistant.io/atom.xml",
    date: "2026-11-11T00:00:01.000Z",
  };
  const reddit = {
    title: "Home Assistant Connect AUX-2",
    url: "https://www.reddit.com/r/homeassistant/comments/1",
    feed_url: "https://www.reddit.com/r/homeassistant/.rss",
    date: "2026-11-11T20:00:00.000Z",
  };
  assert.equal(nearDuplicate(github, blog), true);
  assert.equal(nearDuplicate(other, reddit), false);
  assert.equal(
    nearDuplicate(
      { title: "v25.12.6" },
      { title: "OpenWrt 25.12.6 - Service Release" }
    ),
    true
  );
  const kept = dedupeItems([github, blog]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].url, blog.url);
});

test("drops revoked and test tags unless that is all a feed has", () => {
  const feed = {
    feed_url: "https://github.com/meshtastic/firmware/releases.atom",
    items: [
      { title: "Meshtastic Firmware 2.8.0", url: "https://example.com/stable", date: "2026-10-01T00:00:00Z" },
      { title: "Meshtastic Firmware 2.8.2 Alpha (Revoked)", url: "https://example.com/alpha", date: "2026-11-03T00:00:00Z" },
    ],
  };
  const titles = prepareFeedItems(feed).map((item) => item.title);
  assert.deepEqual(titles, ["Meshtastic Firmware 2.8.0"]);
  const sdk = prepareFeedItems({
    feed_url: "https://github.com/project-chip/connectedhomeip/releases.atom",
    items: [
      { title: "v1.6.1.0 Release", url: "https://example.com/rel", date: "2026-09-25T00:00:00Z" },
      { title: "v1.7-te2: ConnectNetwork test", url: "https://example.com/te", date: "2026-09-16T00:00:00Z" },
    ],
  }).map((item) => item.title);
  assert.deepEqual(sdk, ["v1.6.1.0 Release"]);

  const onlyTest = prepareFeedItems({
    feed_url: "https://github.com/chirpstack/chirpstack/releases.atom",
    items: [{ title: "v4.20.1-test.2", url: "https://example.com/test", date: "2026-11-04T00:00:00Z" }],
  });
  assert.equal(onlyTest.length, 1);
});

test("keeps the last good items when a refresh fails", () => {
  const previous = {
    feeds: [
      {
        feed_url: "https://example.com/rss",
        ok: true,
        fetchedAt: "2026-11-15T12:00:00.000Z",
        lastOkAt: "2026-11-15T12:00:00.000Z",
        items: [{ title: "Old", url: "https://example.com/old", date: "2026-11-15T12:00:00.000Z" }],
      },
    ],
  };
  const merged = mergeResults(previous, [
    {
      name: "Example",
      feed_url: "https://example.com/rss",
      ok: false,
      error: "HTTP 429",
      fetchedAt: "2026-11-16T12:00:00.000Z",
      items: [],
    },
  ]);
  assert.equal(merged[0].retained, true);
  assert.equal(merged[0].items[0].title, "Old");
  assert.equal(merged[0].error, "HTTP 429");
  assert.equal(merged[0].lastOkAt, "2026-11-15T12:00:00.000Z");
});

test("page renders six sections, nav, footer, and escaped titles", () => {
  const feeds = categoriesOf(catalog, []).map((category, index) => ({
    name: "Source " + category,
    site_url: "https://example.com/" + index,
    feed_url: "https://example.com/" + index + "/rss",
    category,
    ok: true,
    error: null,
    fetchedAt: "2026-11-16T06:40:00.000Z",
    lastOkAt: "2026-11-16T06:40:00.000Z",
    items: [
      {
        title: category + " <script>alert(1)</script>",
        url: "https://example.com/post/" + index,
        date: "2026-11-16T06:40:00.000Z",
        excerpt: "Excerpt for " + category,
      },
    ],
  }));
  const html = renderFeedsPage(catalog, {
    refreshedAt: "2026-11-16T06:40:00.000Z",
    stale: false,
    feeds,
  });
  for (const category of categoriesOf(catalog, [])) {
    assert.ok(html.includes(">" + category.replace(/&/g, "&amp;") + "<"), category);
  }
  assert.match(html, /Updated hourly\. Last refresh: Nov 16, 2026, 2:40 AM AST/);
  assert.match(html, /aria-current="page">FEEDS</);
  assert.match(html, /class="foot"/);
  assert.match(html, /signup-trigger/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.equal(html.includes("<script>alert"), false);
  assert.ok(html.includes("alert(1)"));
  assert.equal(sectionItems(feeds, "Home Assistant").length, 1);
  assert.equal(cacheControlFor({ feeds }), HOUR_CACHE);
  assert.equal(cacheControlFor({ feeds: [{ ok: false, items: [] }] }), "public, max-age=120");
});

test("fetch sends the bot user agent and retries HTTP 429 once", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ua: init.headers["User-Agent"] });
    if (calls.length === 1) return new Response("slow down", { status: 429 });
    return new Response(RSS, {
      status: 200,
      headers: { "Content-Type": "application/rss+xml" },
    });
  };
  const feed = {
    name: "Example",
    site_url: "https://example.com",
    feed_url: "https://example.com/rss",
    category: "Home Assistant",
  };
  const result = await fetchOne(feed, { fetch: fetchImpl, retryDelayMs: 0, timeoutMs: 1000 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].ua, USER_AGENT);
  assert.equal(result.ok, true);
  assert.equal(result.items[0].title, "OpenWrt & friends");
});

test("refresh caps concurrency", async () => {
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    return new Response(RSS, { status: 200 });
  };
  const feeds = Array.from({ length: 8 }, (_, i) => ({
    name: "F" + i,
    site_url: "https://example.com/" + i,
    feed_url: "https://example.com/" + i + "/rss",
    category: "Home Assistant",
  }));
  const results = await refreshFeeds(feeds, {
    fetch: fetchImpl,
    concurrency: 3,
    staggerMs: 0,
    retryDelayMs: 0,
  });
  assert.equal(results.length, 8);
  assert.ok(results.every((feed) => feed.ok));
  assert.ok(maxActive <= 3, "max active " + maxActive);
});
