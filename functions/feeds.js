import catalog from "../data/feeds.json";
import {
  cacheControlFor,
  finish,
  getAggregate,
  methodNotAllowed,
  renderFeedsPage,
} from "./_feeds.js";

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
  const result = await getAggregate(catalog);
  return finish(
    context.request,
    renderFeedsPage(catalog, result.aggregate),
    "text/html; charset=utf-8",
    cacheControlFor(result.aggregate),
    result.cache
  );
}
