import {
  handleLogin,
  handleLogout,
  isAuthed,
  loginResponse,
} from "./_lib.js";
import { handleGenerate } from "./generate.js";

function normPath(pathname) {
  const p = pathname.replace(/\/+$/, "");
  return p || "/";
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = normPath(url.pathname);
  const method = context.request.method.toUpperCase();

  if (path === "/admin/login") {
    if (method === "POST") return handleLogin(context);
    if (method === "GET" || method === "HEAD") {
      return loginResponse(context.env, 200);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  if (path === "/admin/logout") {
    if (method === "POST") return handleLogout();
    return new Response("Method not allowed", { status: 405 });
  }

  if (path === "/admin/generate") {
    if (method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (!(await isAuthed(context))) {
      return loginResponse(context.env, 401, "Sign in required.");
    }
    return handleGenerate(context);
  }

  if (await isAuthed(context)) {
    return context.next();
  }

  if (method === "GET" || method === "HEAD") {
    return loginResponse(context.env, 200);
  }
  return loginResponse(context.env, 401, "Sign in required.");
}
