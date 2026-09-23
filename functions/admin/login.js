import { handleLogin, loginResponse } from "./_lib.js";

export async function onRequestGet(context) {
  return loginResponse(context.env, 200);
}

export async function onRequestPost(context) {
  return handleLogin(context);
}
