import catalog from "../data/feeds.json";
import {
  cacheControlFor,
  finish,
  getAggregate,
  methodNotAllowed,
  renderFeedsJson,
} from "./_feeds.js";

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
  const result = await getAggregate(catalog);
  return finish(
    context.request,
    JSON.stringify(renderFeedsJson(catalog, result.aggregate)),
    "application/json; charset=utf-8",
    cacheControlFor(result.aggregate),
    result.cache
  );
}
