const COOKIE = "hanews_admin";
const PREFIX = "hanews-admin";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const enc = new TextEncoder();

function htmlHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

function cookieHeader(value, maxAge) {
  const parts = [
    COOKIE + "=" + value,
    "Path=/admin",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=" + String(maxAge),
  ];
  return parts.join("; ");
}

function readCookie(request) {
  const raw = request.headers.get("Cookie") || "";
  const pieces = raw.split(";");
  for (let i = 0; i < pieces.length; i++) {
    const part = pieces[i].trim();
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    if (part.slice(0, eq) === COOKIE) return part.slice(eq + 1);
  }
  return "";
}

function adminPassword(env) {
  const v = env && env.ADMIN_PASSWORD;
  return typeof v === "string" ? v : "";
}

async function importHmacKey(password) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function toHex(buf) {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex) {
  if (!hex || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const n = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(n)) return null;
    out[i] = n;
  }
  return out;
}

export async function timingSafeEqual(a, b) {
  const aBytes = enc.encode(String(a));
  const bBytes = enc.encode(String(b));
  const len = Math.max(aBytes.length, bBytes.length, 1);
  const aPad = new Uint8Array(len);
  const bPad = new Uint8Array(len);
  aPad.set(aBytes);
  bPad.set(bBytes);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= aPad[i] ^ bPad[i];
  }
  return diff === 0;
}

async function mintCookie(password) {
  const exp = Date.now() + TTL_MS;
  const msg = PREFIX + "|" + String(exp);
  const key = await importHmacKey(password);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return String(exp) + "." + toHex(sig);
}

async function cookieValid(password, value) {
  if (!password || !value) return false;
  const dot = value.indexOf(".");
  if (dot < 1) return false;
  const expStr = value.slice(0, dot);
  const hex = value.slice(dot + 1);
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const mac = fromHex(hex);
  if (!mac) return false;
  const key = await importHmacKey(password);
  return crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    enc.encode(PREFIX + "|" + expStr)
  );
}

export async function isAuthed(context) {
  const password = adminPassword(context.env);
  if (!password) return false;
  return cookieValid(password, readCookie(context.request));
}

function layout(title, body) {
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "  <title>" +
    title +
    "</title>\n" +
    '  <meta name="robots" content="noindex, nofollow">\n' +
    '  <link rel="stylesheet" href="/styles.css">\n' +
    "</head>\n" +
    '<body class="admin-body">\n' +
    body +
    "</body>\n" +
    "</html>\n"
  );
}

function loginBody(env, errorText) {
  const unset = !adminPassword(env);
  const notes = [];
  if (unset) notes.push("Admin password is not set yet.");
  if (errorText) notes.push(errorText);
  let noteHtml = "";
  for (let i = 0; i < notes.length; i++) {
    noteHtml +=
      '<p class="admin-err" role="status">' + notes[i] + "</p>\n";
  }
  return (
    '<main class="admin-login">\n' +
    '  <p class="kicker">HA News</p>\n' +
    "  <h1>HA News Admin</h1>\n" +
    noteHtml +
    '  <form class="admin-form" method="post" action="/admin/login" autocomplete="off">\n' +
    '    <label for="password">Password</label>\n' +
    '    <input id="password" name="password" type="password" required autocomplete="current-password">\n' +
    '    <button type="submit">Open admin</button>\n' +
    "  </form>\n" +
    "</main>\n"
  );
}

export function loginResponse(env, status, errorText) {
  return new Response(layout("HA News Admin", loginBody(env, errorText || "")), {
    status: status,
    headers: htmlHeaders(),
  });
}

export async function handleLogin(context) {
  const env = context.env;
  const password = adminPassword(env);
  if (!password) {
    return loginResponse(env, 401);
  }
  let submitted = "";
  try {
    const form = await context.request.formData();
    const field = form.get("password");
    submitted = field == null ? "" : String(field);
  } catch {
    return loginResponse(env, 401, "Could not sign in.");
  }
  const ok = await timingSafeEqual(submitted, password);
  if (!ok) {
    return loginResponse(env, 401, "Could not sign in.");
  }
  const value = await mintCookie(password);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/admin",
      "Set-Cookie": cookieHeader(value, Math.floor(TTL_MS / 1000)),
      "Cache-Control": "no-store",
    },
  });
}

export function handleLogout() {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/admin",
      "Set-Cookie": cookieHeader("", 0),
      "Cache-Control": "no-store",
    },
  });
}

export async function subscriberSummary(env) {
  const kv = env && env.SUBSCRIBERS;
  if (!kv) {
    return "Subscriber KV is not bound in this environment, so there is no waitlist count to show.";
  }
  if (typeof kv.list !== "function") {
    return "Waitlist storage is bound. A key count is not available here.";
  }
  try {
    let confirmed = 0;
    let pending = 0;
    let cursor;
    for (;;) {
      const page = await kv.list(cursor ? { cursor: cursor } : {});
      const keys = Array.isArray(page.keys) ? page.keys : [];
      for (let i = 0; i < keys.length; i++) {
        const name = keys[i] && keys[i].name;
        if (typeof name !== "string") continue;
        if (name.startsWith("draft:") || name.startsWith("token:")) continue;
        let rec = null;
        if (typeof kv.get === "function") {
          try {
            const raw = await kv.get(name);
            rec = raw ? JSON.parse(raw) : null;
          } catch {
            rec = null;
          }
        }
        if (rec && rec.confirmed === true) confirmed += 1;
        else pending += 1;
      }
      if (page.list_complete || !page.cursor) break;
      cursor = page.cursor;
    }
    return (
      String(confirmed) +
      " confirmed, " +
      String(pending) +
      " pending confirm"
    );
  } catch {
    return "Waitlist storage is bound. A key count is not available here.";
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function adminErrorResponse(status, message) {
  const body =
    '<main class="admin-login">\n' +
    '  <p class="kicker">HA News</p>\n' +
    "  <h1>Could not draft</h1>\n" +
    '  <p class="admin-err" role="status">' +
    escapeHtml(message) +
    "</p>\n" +
    '  <p><a href="/admin">Back to admin</a></p>\n' +
    "</main>\n";
  return new Response(layout("HA News admin", body), {
    status: status,
    headers: htmlHeaders(),
  });
}

async function listDrafts(env) {
  const kv = env && env.SUBSCRIBERS;
  if (!kv || typeof kv.list !== "function" || typeof kv.get !== "function") {
    return [];
  }
  const out = [];
  let cursor;
  try {
    for (;;) {
      const opts = { prefix: "draft:" };
      if (cursor) opts.cursor = cursor;
      const page = await kv.list(opts);
      const keys = Array.isArray(page.keys) ? page.keys : [];
      for (let i = 0; i < keys.length; i++) {
        const name = keys[i] && keys[i].name;
        if (typeof name !== "string") continue;
        let title = "Untitled draft";
        let type = "news post";
        let date = "";
        let ts = "";
        try {
          const raw = await kv.get(name);
          const obj = raw ? JSON.parse(raw) : null;
          if (obj && obj.title) title = String(obj.title);
          if (obj && obj.type) type = String(obj.type);
          if (obj && obj.date) date = String(obj.date);
          if (obj && obj.ts) ts = String(obj.ts);
        } catch {
          /* keep fallbacks */
        }
        out.push({ title: title, type: type, date: date, ts: ts });
      }
      if (page.list_complete || !page.cursor) break;
      cursor = page.cursor;
    }
  } catch {
    return out;
  }
  out.sort(function (a, b) {
    if (a.ts === b.ts) return 0;
    return a.ts < b.ts ? 1 : -1;
  });
  return out;
}

function draftRowsHtml(drafts) {
  let html = "";
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    html +=
      "        <tr><td>" +
      escapeHtml(d.title || "Untitled draft") +
      "</td><td>" +
      escapeHtml(d.type || "news post") +
      "</td><td>Draft</td><td>" +
      escapeHtml(d.date || "") +
      "</td></tr>\n";
  }
  return html;
}

function dashboardBody(subNote, drafts) {
  const rows = draftRowsHtml(drafts || []);
  const empty =
    drafts && drafts.length
      ? ""
      : '    <p class="admin-empty">No unpublished drafts in the queue. Next pipeline brief will land here as Draft before it is public.</p>\n';
  return (
    '<header class="admin-mast">\n' +
    '  <div class="sheet admin-mast-row">\n' +
    '    <a class="brand" href="/admin"><span class="wordmark">HA News admin</span></a>\n' +
    '    <form method="post" action="/admin/logout">\n' +
    '      <button class="admin-logout" type="submit">Log out</button>\n' +
    "    </form>\n" +
    "  </div>\n" +
    "</header>\n" +
    '<main class="sheet admin-shell wide">\n' +
    '  <p class="kicker">Desk</p>\n' +
    "  <h1>HA News admin</h1>\n" +
    '  <p class="lede">Articles before they go live, and an honest log of how the paper runs today. Nothing here is public until it is marked ready and then deployed.</p>\n' +
    "\n" +
    '  <section class="admin-section" aria-labelledby="drafts-h">\n' +
    '    <h2 id="drafts-h">Drafts</h2>\n' +
    '    <p class="admin-note">Adam approved autonomous weekday publish 2026-09-08. Public site is the live daily brief; ping him after each live drop. No subscriber email without ask.</p>\n' +
    '    <p class="admin-note">Writer: Ollama Cloud qwen3.5:397b, drafts only.</p>\n' +
    '    <table class="admin-table">\n' +
    "      <thead>\n" +
    "        <tr><th>Title</th><th>Type</th><th>Status</th><th>Date</th></tr>\n" +
    "      </thead>\n" +
    "      <tbody>\n" +
    rows +
    '        <tr><td><a href="/article-esphome-starter-kit.html">ESPHome Starter Kit</a></td><td>news post</td><td>Live (sample)</td><td>15 Aug 2026</td></tr>\n' +
    '        <tr><td><a href="/ha.html">2026.8 Approachable by design (HA)</a></td><td>news post</td><td>Live (sample)</td><td>15 Aug 2026</td></tr>\n' +
    '        <tr><td><a href="/matter.html">Homey Matter 1.5 certified</a></td><td>news post</td><td>Live (sample)</td><td>15 Aug 2026</td></tr>\n' +
    '        <tr><td><a href="/brief-2026-08-15.html">Brief for 15 Aug 2026</a></td><td>brief item</td><td>Live (sample)</td><td>15 Aug 2026</td></tr>\n' +
    '        <tr><td><a href="/explainer-matter-15.html">Matter 1.5, explained</a></td><td>explainer</td><td>Live (sample)</td><td>15 Aug 2026</td></tr>\n' +
    '        <tr><td><a href="/explainer-esphome-kit.html">What the ESPHome Starter Kit actually is</a></td><td>explainer</td><td>Live (sample)</td><td>15 Aug 2026</td></tr>\n' +
    '        <tr><td><a href="/devices.html">SwitchBot Circulator Fan 2 Pro</a></td><td>news post</td><td>Live (sample)</td><td>15 Aug 2026</td></tr>\n' +
    "      </tbody>\n" +
    "    </table>\n" +
    empty +
    '    <form class="admin-form admin-generate" method="post" action="/admin/generate">\n' +
    '      <button type="submit">Draft ESPHome kit post (sample)</button>\n' +
    "    </form>\n" +
    "  </section>\n" +
    "\n" +
    '  <section class="admin-section admin-log" aria-labelledby="run-h">\n' +
    '    <h2 id="run-h">How this is run</h2>\n' +
    "    <p>As of 30 Aug 2026. The brand is HA News (hanews.org). The beat is home automation. Home Assistant is a section, not the paper name. The tagline is: Reporting the local stack, from radio to automations.</p>\n" +
    '    <p>The public site is the Cloudflare Pages project <code>hanews</code>, live at <a href="https://hanews.org">https://hanews.org</a> and <a href="https://www.hanews.org">www</a>.</p>\n' +
    "    <p>Writer: Ollama Cloud <code>qwen3.5:397b</code>, drafts only. Generated copy is stored in KV as Draft and is never published to public HTML from this desk.</p>\n" +
    '    <p>The engine is the GitHub repo <a href="https://github.com/adamb/hanews">https://github.com/adamb/hanews</a>, a Python pipeline (RSS + GitHub → SQLite → dedupe → score → Markdown digest). It runs on Roux, with the venv and data on /mnt/backup/hanews. AGENTS.md still stands: no apt, docker, or system changes, and no autonomous public publishing.</p>\n' +
    "    <p>The cadence we are aiming for is weekdays: a daily briefing rail of 5–10 scored items, and a short news post in the center well only if a story clears the bar. Monday gets one evergreen explainer. The email list gets the weekday brief once sending is turned on.</p>\n" +
    "    <p>The public subscribe form collects name, email, and phone. Those rows are stored in the Cloudflare KV binding SUBSCRIBERS (id 0f64d5199cb844eab5bc654e61496a65) on Adam’s personal Cloudflare account. Signups get an ImprovMX confirmation email from hello@hanews.org and stay pending until GET /confirm?token= succeeds. Newsletter sending is still not on. No SMS is sent. Set IMPROVMX_API_KEY (required to send) as a Pages secret, plus optional MAIL_DOMAIN and MAIL_FROM_LOCAL — never commit them.</p>\n" +
    "    <p>The publish path is: files get built, then <code>wrangler pages deploy</code> to the hanews project. Git auto-deploy on push is the intended loop. It is not connected yet.</p>\n" +
    "    <p>Adam approved autonomous weekday publish 2026-09-08; ping him after each live drop; no subscriber email without ask.</p>\n" +
    "    <p>Google Analytics 4 will load on public pages once GA_MEASUREMENT_ID is set. It does not load on /admin.</p>\n" +
    "    <p>What is not built yet: sending the newsletter, Search Console and Bing (a friend had those too; not this change), and wiring the Roux pipeline to drop drafts into this admin automatically.</p>\n" +
    "  </section>\n" +
    "\n" +
    '  <section class="admin-section" aria-labelledby="subs-h">\n' +
    '    <h2 id="subs-h">Subscribers</h2>\n' +
    '    <p class="admin-note">' +
    subNote +
    "</p>\n" +
    "  </section>\n" +
    "</main>\n"
  );
}

export async function dashboardResponse(env) {
  const subNote = await subscriberSummary(env);
  const drafts = await listDrafts(env);
  return new Response(layout("HA News admin", dashboardBody(subNote, drafts)), {
    status: 200,
    headers: htmlHeaders(),
  });
}
