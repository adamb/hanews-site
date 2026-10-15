const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
const MAIL_COOLDOWN_MS = 120 * 1000;

// Anti-abuse guards (branch: fix/subscribe-abuse-guards)
// KV counters are last-writer-wins, not atomic — they are approximate by
// design. They are good enough to stop bot floods; not for billing.
const IP_LIMIT_PER_HOUR = 5;
const DAILY_SEND_CAP = 150;

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com","10minutemail.com","10minutemail.net","guerrillamail.com",
  "guerrillamail.net","guerrillamail.org","guerrillamailblock.com","tempmail.com",
  "temp-mail.org","temp-mail.io","throwawaymail.com","yopmail.com","yopmail.fr",
  "getnada.com","nada.email","dispostable.com","sharklasers.com","trashmail.com",
  "trashmail.de","mytemp.email","emailondeck.com","fakeinbox.com","mailnesia.com",
  "spamgourmet.com","burnermail.io","33mail.com","dropmail.me","instantemailaddress.com",
  "mohmal.com","tmpmail.net","nowmymail.com","1secmail.com","1secmail.net",
  "email-temp.com","tempmailo.com","moakt.com","tmailor.com","meltmail.com",
]);

function isDisposable(email) {
  const domain = email.split("@")[1] || "";
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}



async function verifyTurnstile(env, token, ip) {
  if (!env || !env.TURNSTILE_SECRET) return true; // not configured yet
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    });
    const data = await res.json();
    return !!(data && data.success);
  } catch {
    return false;
  }
}

async function bumpCounter(kv, key, limit) {
  const raw = await kv.get(key);
  const n = Number.parseInt(raw || "0", 10) || 0;
  if (n >= limit) return false;
  await kv.put(key, String(n + 1));
  return true;
}

function hourKey(ip) {
  const h = new Date();
  return "rl:" + ip + ":" + h.toISOString().slice(0, 13);
}

function dayKey() {
  return "cap:" + new Date().toISOString().slice(0, 10);
}

function corsHeaders(request) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  };
  const origin = request.headers.get("Origin");
  const url = new URL(request.url);
  if (origin && origin === url.origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
  }
  return { headers, origin, url, sameOrigin: !origin || origin === url.origin };
}

function json(request, body, status) {
  const { headers, sameOrigin, origin } = corsHeaders(request);
  if (origin && !sameOrigin) {
    return new Response(JSON.stringify({ ok: false, error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function parseRecord(raw) {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    return rec && typeof rec === "object" ? rec : null;
  } catch {
    return null;
  }
}

function recentlySent(lastSent) {
  if (!lastSent) return false;
  const t = Date.parse(lastSent);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < MAIL_COOLDOWN_MS;
}

function confirmUrl(request, token) {
  return new URL(request.url).origin + "/confirm?token=" + token;
}

function mailText(url) {
  return (
    "Confirm your HA News subscription by opening this link:\n\n" +
    url +
    "\n\nThis link expires in 48 hours.\n\nIf you did not subscribe, ignore this.\n"
  );
}

function mailHtml(url) {
  const href = String(url)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return (
    "<p>Confirm your HA News subscription:</p><p>" +
    href +
    "</p><p>This link expires in 48 hours. If you did not subscribe, ignore this.</p>"
  );
}

async function sendConfirmMail(env, request, email, token) {
  const url = confirmUrl(request, token);
  const domain = (env && env.MAIL_DOMAIN) || "hanews.org";
  const fromLocal = (env && env.MAIL_FROM_LOCAL) || "hello";
  const res = await fetch(
    "https://api.improvmx.com/v4/domains/" + encodeURIComponent(domain) + "/emails/outbound",
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa("api:" + env.IMPROVMX_API_KEY),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromLocal,
        to: email,
        subject: "HA News: confirm your subscription",
        text: mailText(url),
        html: mailHtml(url),
      }),
    }
  );
  return res;
}

export async function onRequestOptions(context) {
  const { headers, sameOrigin, origin } = corsHeaders(context.request);
  if (origin && !sameOrigin) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const { origin, sameOrigin } = corsHeaders(request);
  if (origin && !sameOrigin) {
    return json(request, { ok: false, error: "forbidden" }, 403);
  }

  let name = "";
  let email = "";
  let turnstileToken = "";
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  try {
    if (ct.includes("application/json")) {
      const body = await request.json();
      name = String((body && body.name) || "").trim();
      email = String((body && body.email) || "").trim();
      turnstileToken = String((body && body.turnstileToken) || (body && body["cf-turnstile-response"]) || "").trim();
    } else {
      const form = await request.formData();
      name = String(form.get("name") || "").trim();
      email = String(form.get("email") || "").trim();
      turnstileToken = String(form.get("cf-turnstile-response") || "").trim();
    }
  } catch {
    return json(request, { ok: false, error: "invalid_body" }, 400);
  }

  if (name.length < 1 || name.length > 80) {
    return json(request, { ok: false, error: "invalid_name" }, 400);
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json(request, { ok: false, error: "invalid_email" }, 400);
  }
  if (isDisposable(email)) {
    return json(request, { ok: false, error: "blocked_email" }, 400);
  }

  const kv = env && env.SUBSCRIBERS;
  if (!kv) {
    return json(request, { ok: true, live: false, mailed: false }, 202);
  }

  // Turnstile: verified server-side. If TURNSTILE_SECRET is unset the check
  // passes so existing deploys do not break until the widget is wired up.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const turnstileOk = await verifyTurnstile(env, turnstileToken, ip);
  if (!turnstileOk) {
    return json(request, { ok: false, error: "captcha_failed" }, 400);
  }

  // Per-source-IP hourly limit. Counted BEFORE any send so floods burn the
  // budget instead of the inbox.
  if (ip !== "unknown" && !(await bumpCounter(kv, hourKey(ip), IP_LIMIT_PER_HOUR))) {
    return json(request, { ok: false, error: "rate_limited", retry: "hour" }, 429);
  }

  const key = email.toLowerCase();
  const existing = parseRecord(await kv.get(key));
  if (existing && existing.confirmed === true) {
    return json(request, { ok: true, confirmed: true, mailed: false }, 202);
  }

  // Check lastSent before rotating the token so a throttled retry
  // does not invalidate the confirm link already in the inbox.
  if (existing && recentlySent(existing.lastSent)) {
    return json(
      request,
      { ok: true, confirmed: false, mailed: false, throttled: true },
      202
    );
  }

  // Daily cap on confirmation emails out of this domain. Checked before the
  // mail API call. If the counter is somehow corrupt we fail closed.
  if (!(await bumpCounter(kv, dayKey(), DAILY_SEND_CAP))) {
    return json(request, { ok: true, confirmed: false, mailed: false, throttled: true }, 202);
  }

  const now = new Date();
  const token = randomToken();
  const tokenExp = new Date(now.getTime() + TOKEN_TTL_MS).toISOString();
  if (existing && existing.token) {
    await kv.delete("token:" + existing.token);
  }

  // Phone field dropped: never required, never stored.
  const record = {
    name: name,
    email: email,
    ts: existing && existing.ts ? existing.ts : now.toISOString(),
    confirmed: false,
    token: token,
    tokenExp: tokenExp,
  };
  if (existing && existing.lastSent) record.lastSent = existing.lastSent;

  await kv.put(key, JSON.stringify(record));
  await kv.put("token:" + token, key);

  const apiKey = env && env.IMPROVMX_API_KEY;
  if (typeof apiKey !== "string" || !apiKey) {
    return json(request, { ok: true, confirmed: false, mailed: false }, 202);
  }

  let mailed = false;
  try {
    const res = await sendConfirmMail(env, request, email, token);
    mailed = !!(res && res.ok);
  } catch {
    mailed = false;
  }
  if (!mailed) {
    return json(request, { ok: false, error: "mail_failed" }, 502);
  }

  record.lastSent = now.toISOString();
  await kv.put(key, JSON.stringify(record));
  return json(request, { ok: true, confirmed: false, mailed: true }, 202);
}