import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HOUR_CACHE,
  USER_AGENT,
  activeFeeds,
  aggregateFreshForMs,
  arcticSearchUrl,
  cacheControlFor,
  categoriesOf,
  dedupeItems,
  fetchOne,
  formatAst,
  isLowPriority,
  mergeResults,
  nearDuplicate,
  parseArctic,
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

test("catalog keeps the 70 v2 feeds and drops the stale ones", () => {
  const feeds = activeFeeds(catalog);
  assert.equal(feeds.length, 70);
  assert.equal(feeds.filter((feed) => feed.status === "dropped").length, 0);
  assert.equal(feeds.filter((feed) => isLowPriority(feed)).length, 20);
  assert.equal(feeds.filter((feed) => feed.intake === "arctic-shift").length, 9);
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
  assert.equal(
    feeds.some((feed) => String(feed.feed_url).includes("hackaday.com/tag/home-automation")),
    false
  );
  assert.equal(
    feeds.some((feed) => feed.feed_url === "https://www.howtogeek.com/feed/category/smart-home/"),
    true
  );
  assert.equal(feeds.some((feed) => /https?:\/\/([^/]*\.)?reddit\.com/i.test(feed.feed_url)), false);
  const opml = renderOpml(catalog);
  assert.equal((opml.match(/xmlUrl="/g) || []).length, 70);
  assert.equal(opml.includes("staceyoniot.com"), false);
  assert.equal(opml.includes("hackaday.com/tag/home-automation"), false);
  assert.equal(opml.includes("forum.openwrt.org/c/announcements/14.rss"), true);
  assert.equal(opml.includes("https://www.howtogeek.com/feed/category/smart-home/"), true);
  assert.equal(opml.includes("contributors.home-assistant.io/blog/rss.xml"), true);
  assert.equal(opml.includes("https://www.reddit.com/r/homeassistant/.rss"), true);
  assert.equal(opml.includes("Arctic Shift"), true);
  assert.equal(opml.includes("arctic-shift.photon-reddit.com"), false);
  const dropped = activeFeeds({
    categories: ["Home Assistant"],
    feeds: [
      {
        name: "Gone",
        category: "Home Assistant",
        feed_url: "https://example.com/gone.xml",
        status: "dropped",
        intake: "rss",
      },
    ],
  });
  assert.equal(dropped.length, 0);
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

test("low-priority feeds stay out of the main river and in the shelf", () => {
  const feeds = [
    {
      name: "How-To Geek: Smart Home",
      category: "Smart home news",
      priority: "high",
      feed_url: "https://www.howtogeek.com/feed/category/smart-home/",
      items: [
        {
          title: "A practical automation",
          url: "https://www.howtogeek.com/example/",
          date: "2026-11-16T12:00:00.000Z",
          excerpt: "Do this at home.",
        },
      ],
    },
    {
      name: "Home Assistant Core releases",
      category: "Home Assistant",
      priority: "low",
      status: "deprioritize",
      feed_url: "https://github.com/home-assistant/core/releases.atom",
      items: [
        {
          title: "2026.11.2",
          url: "https://github.com/home-assistant/core/releases/tag/2026.11.2",
          date: "2026-11-16T20:00:00.000Z",
          excerpt: "",
        },
      ],
    },
  ];
  assert.equal(sectionItems(feeds, "Home Assistant").length, 0);
  const shelf = sectionItems(feeds, "Home Assistant", { low: true });
  assert.equal(shelf.length, 1);
  assert.equal(shelf[0].title, "2026.11.2");
  assert.equal(sectionItems(feeds, "Smart home news").length, 1);
  const html = renderFeedsPage(
    { categories: ["Home Assistant", "Smart home news"] },
    { refreshedAt: "2026-11-16T06:40:00.000Z", stale: false, feeds }
  );
  assert.match(html, /<details class="feed-shelf"><summary>Release notes &amp; industry<\/summary>/);
  const shelfStart = html.indexOf("<details class=\"feed-shelf\">");
  const shelfHtml = html.slice(shelfStart, html.indexOf("</details>", shelfStart));
  assert.ok(shelfHtml.includes("2026.11.2"));
  assert.equal(shelfHtml.includes("A practical automation"), false);
  assert.ok(html.includes("A practical automation"));
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

const ARCTIC_FEED = {
  name: "r/homeassistant",
  site_url: "https://www.reddit.com/r/homeassistant/",
  feed_url: "https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=homeassistant",
  category: "Home Assistant",
  format: "arctic-shift",
  intake: "arctic-shift",
  status: "replace",
  priority: "normal",
  subreddit: "homeassistant",
  arctic: {
    endpoint: "https://arctic-shift.photon-reddit.com/api/posts/search",
    fields: "title,created_utc,score,id,selftext,subreddit,permalink",
    after: "168h",
    limit: 60,
    min_score: 15,
    min_score_age_hours: 36,
    link_template: "https://www.reddit.com/r/{subreddit}/comments/{id}/",
  },
};

test("arctic-shift queries by epoch seconds and retries a 422 with limit 25", async () => {
  const nowSec = 1763330000;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const parsed = new URL(url);
    assert.equal(parsed.host, "arctic-shift.photon-reddit.com");
    assert.equal(parsed.searchParams.get("subreddit"), "homeassistant");
    assert.equal(parsed.searchParams.get("after"), String(nowSec - 168 * 3600));
    assert.equal(
      parsed.searchParams.get("fields"),
      "title,created_utc,score,id,selftext,subreddit"
    );
    assert.equal(parsed.searchParams.has("permalink"), false);
    assert.equal(String(url).includes("permalink"), false);
    assert.equal(parsed.host.endsWith(".reddit.com") || parsed.host === "reddit.com", false);
    if (parsed.searchParams.get("limit") === "60") {
      return new Response("unprocessable", { status: 422 });
    }
    assert.equal(parsed.searchParams.get("limit"), "25");
    const young = nowSec - 2 * 3600;
    const old = nowSec - 50 * 3600;
    const data = [
      {
        id: "oldhot1",
        title: "Old hot post",
        score: 40,
        created_utc: old,
        selftext: "A useful writeup of a Home Assistant dashboard that is long enough.",
        subreddit: "homeassistant",
      },
      {
        id: "oldquiet",
        title: "Old quiet post",
        score: 2,
        created_utc: old - 10,
        selftext: "This older post is under the score floor and must be hidden.",
        subreddit: "homeassistant",
      },
      {
        id: "newquiet",
        title: "New quiet post",
        score: 1,
        created_utc: young,
        selftext: "Just asked this today, scores have not caught up yet at all.",
        subreddit: "homeassistant",
      },
    ];
    for (let i = 0; i < 6; i++) {
      data.push({
        id: "fresh" + i,
        title: "Fresh post " + i,
        score: 1,
        created_utc: young - i * 60,
        selftext: "Another brand new post that should be capped in the kept list.",
        subreddit: "homeassistant",
      });
    }
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const result = await fetchOne(ARCTIC_FEED, { fetch: fetchImpl, nowSec, timeoutMs: 1000 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes("User-Agent"), false);
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  const titles = result.items.map((item) => item.title);
  assert.equal(titles.includes("Old quiet post"), false);
  assert.equal(titles.includes("Old hot post"), true);
  assert.equal(titles.includes("New quiet post"), true);
  assert.ok(titles.filter((title) => title.startsWith("Fresh post")).length <= 4);
  const fresh = result.items.find((item) => item.title === "New quiet post");
  assert.equal(fresh.url, "https://www.reddit.com/r/homeassistant/comments/newquiet/");
  assert.ok(fresh.excerpt.length >= 20);
  assert.equal(calls.some((url) => url.includes("www.reddit.com")), false);
});

test("arctic-shift retries one HTTP 429 and does not call reddit.com", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response("slow", { status: 429 });
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "abc123",
            title: "Recovered post",
            score: 20,
            created_utc: 1763330000 - 100,
            selftext: "Long enough selftext to keep as an excerpt here.",
            subreddit: "homeassistant",
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  const result = await fetchOne(ARCTIC_FEED, {
    fetch: fetchImpl,
    nowSec: 1763330000,
    retryDelayMs: 0,
    timeoutMs: 1000,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.ok, true);
  assert.equal(result.items[0].url, "https://www.reddit.com/r/homeassistant/comments/abc123/");
  assert.equal(calls.every((url) => !new URL(url).host.endsWith(".reddit.com")), true);
  assert.equal(aggregateFreshForMs([{ intake: "arctic-shift", ok: false, error: "HTTP 429" }]), 90000);
  assert.equal(aggregateFreshForMs([{ intake: "arctic-shift", ok: true, error: null }]), 60 * 60 * 1000);
});

test("arctic-shift requests run one at a time", async () => {
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const feeds = ["homeassistant", "openwrt", "esphome"].map((sub) => ({
    ...ARCTIC_FEED,
    name: "r/" + sub,
    subreddit: sub,
    feed_url: "https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=" + sub,
  }));
  const results = await refreshFeeds(feeds, {
    fetch: fetchImpl,
    staggerMs: 0,
    timeoutMs: 1000,
    nowSec: 1763330000,
  });
  assert.equal(results.length, 3);
  assert.ok(results.every((feed) => feed.ok));
  assert.equal(maxActive, 1);
});

test("arctic-shift does not fall back to reddit.com RSS", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response("nope", { status: 500 });
  };
  const result = await fetchOne(ARCTIC_FEED, {
    fetch: fetchImpl,
    nowSec: 1763330000,
    timeoutMs: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "HTTP 500");
  assert.equal(result.items.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).host.endsWith(".reddit.com"), false);
  const blocked = await fetchOne(
    {
      name: "r/homeassistant",
      site_url: "https://www.reddit.com/r/homeassistant/",
      feed_url: "https://www.reddit.com/r/homeassistant/.rss",
      category: "Home Assistant",
      intake: "rss",
    },
    { fetch: fetchImpl, timeoutMs: 1000 }
  );
  assert.equal(blocked.error, "reddit rss disabled");
  assert.equal(calls.length, 1);
});

test("a failing source does not reject the rest of the refresh", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("bad.example")) throw new Error("socket hang up");
    return new Response(RSS, { status: 200 });
  };
  const results = await refreshFeeds(
    [
      {
        name: "Bad",
        site_url: "https://bad.example",
        feed_url: "https://bad.example/rss",
        category: "Home Assistant",
        intake: "rss",
      },
      {
        name: "Good",
        site_url: "https://example.com",
        feed_url: "https://example.com/rss",
        category: "Home Assistant",
        intake: "rss",
      },
    ],
    { fetch: fetchImpl, concurrency: 2, staggerMs: 0, retryDelayMs: 0, timeoutMs: 1000 }
  );
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error, "network error");
  assert.equal(results[1].ok, true);
  assert.equal(results[1].items[0].title, "OpenWrt & friends");
});

test("parseArctic applies min_score only after the age window", () => {
  const nowSec = 1763330000;
  const parsed = parseArctic(
    JSON.stringify({
      data: [
        { id: "aa", title: "Young", score: 1, created_utc: nowSec - 3600, selftext: "", subreddit: "openwrt" },
        { id: "bb", title: "Old enough", score: 3, created_utc: nowSec - 40 * 3600, selftext: "", subreddit: "openwrt" },
        { id: "cc", title: "Old and hot", score: 9, created_utc: nowSec - 40 * 3600, selftext: "", subreddit: "openwrt" },
      ],
    }),
    { ...ARCTIC_FEED, subreddit: "openwrt", arctic: { ...ARCTIC_FEED.arctic, min_score: 8 } },
    nowSec
  );
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.items.map((item) => item.title).sort(),
    ["Old and hot", "Young"]
  );
  const url = arcticSearchUrl(ARCTIC_FEED, 60, nowSec);
  assert.equal(new URL(url).searchParams.get("fields").includes("permalink"), false);
});
