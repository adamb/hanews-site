// Hourly feed fetch. Run by GitHub Actions, never by a visitor request.
// Writes the aggregate JSON for `wrangler kv:key put` into SUBSCRIBERS
// at key feeds:aggregate. Arctic Shift is fetched one subreddit at a time.

import { readFileSync, writeFileSync } from "node:fs";

import { activeFeeds, aggregateFreshForMs, mergeResults, refreshFeeds } from "../functions/_feeds.js";

const catalog = JSON.parse(readFileSync(new URL("../data/feeds.json", import.meta.url), "utf8"));
const outPath = process.argv[2] || "feeds-aggregate.json";
const started = Date.now();
const fresh = await refreshFeeds(activeFeeds(catalog), { timeoutMs: 8000 });
const merged = mergeResults(null, fresh);
const aggregate = {
  refreshedAt: new Date().toISOString(),
  stale: false,
  freshForMs: aggregateFreshForMs(merged),
  feeds: merged,
};
writeFileSync(outPath, JSON.stringify(aggregate));
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
