import catalog from "../data/feeds.json";
import { HOUR_CACHE, finish, methodNotAllowed, renderOpml } from "./_feeds.js";

export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return methodNotAllowed();
  return finish(
    context.request,
    renderOpml(catalog),
    "text/x-opml; charset=utf-8",
    HOUR_CACHE,
    "static"
  );
}
