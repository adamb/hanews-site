import { dashboardResponse } from "./_lib.js";

export async function onRequestGet(context) {
  return dashboardResponse(context.env);
}
