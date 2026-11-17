import catalog from "../data/feeds.json";
import { finish, loadFeeds, methodNotAllowed, placeholderAggregate, renderFeedsJson } from "./_feeds.js";

export async function onRequest(context) {
  const request = context.request;
  try {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
    const loaded = await loadFeeds(context.env, catalog);
    return finish(
      request,
      JSON.stringify(renderFeedsJson(catalog, loaded.aggregate)),
      "application/json; charset=utf-8",
      loaded.cacheControl,
      loaded.cache
    );
  } catch (err) {
    console.log("feeds json handler failed");
    return finish(
      request,
      JSON.stringify(renderFeedsJson(catalog, placeholderAggregate(catalog))),
      "application/json; charset=utf-8",
      "public, max-age=60",
      "empty"
    );
  }
}
