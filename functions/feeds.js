import catalog from "../data/feeds.json";
import { fallbackFeedsResponse, finish, loadFeeds, methodNotAllowed, renderFeedsPage } from "./_feeds.js";

export async function onRequest(context) {
  const request = context.request;
  try {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
    const loaded = await loadFeeds(context.env, catalog);
    return finish(
      request,
      renderFeedsPage(catalog, loaded.aggregate),
      "text/html; charset=utf-8",
      loaded.cacheControl,
      loaded.cache
    );
  } catch (err) {
    console.log("feeds handler failed");
    return fallbackFeedsResponse(request, catalog);
  }
}
