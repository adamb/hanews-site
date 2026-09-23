const TOKEN_RE = /^[a-f0-9]{64}$/i;

function htmlHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title, heading, message) {
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "  <title>" +
    escapeHtml(title) +
    "</title>\n" +
    '  <meta name="robots" content="noindex, nofollow">\n' +
    '  <link rel="stylesheet" href="/styles.css">\n' +
    "</head>\n" +
    "<body>\n" +
    '  <header class="mast confirm-head">\n' +
    '    <div class="sheet">\n' +
    '      <a class="brand" href="/"><span class="wordmark">HA News</span></a>\n' +
    "    </div>\n" +
    "  </header>\n" +
    '  <main id="main" class="page">\n' +
    '    <div class="sheet">\n' +
    '      <div class="page-inner confirm-inner">\n' +
    '        <p class="kicker">Subscribe</p>\n' +
    "        <h1>" +
    escapeHtml(heading) +
    "</h1>\n" +
    '        <p class="lede">' +
    escapeHtml(message) +
    "</p>\n" +
    '        <p><a href="/">Back to the homepage</a></p>\n' +
    "      </div>\n" +
    "    </div>\n" +
    "  </main>\n" +
    "</body>\n" +
    "</html>\n"
  );
}

function page(status, title, heading, message) {
  return new Response(layout(title, heading, message), {
    status: status,
    headers: htmlHeaders(),
  });
}

function invalidPage() {
  return page(
    400,
    "Confirm — HA News",
    "Link missing or invalid",
    "This confirmation link is missing or invalid."
  );
}

function expiredPage() {
  return page(
    410,
    "Confirm — HA News",
    "Link expired or used",
    "This link is expired or already used. Subscribe again from the homepage."
  );
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const token = String(url.searchParams.get("token") || "").trim();
  if (!token || !TOKEN_RE.test(token)) {
    return invalidPage();
  }

  const kv = env && env.SUBSCRIBERS;
  if (!kv || typeof kv.get !== "function") {
    return expiredPage();
  }

  const emailKey = await kv.get("token:" + token);
  if (!emailKey) {
    return expiredPage();
  }

  const rec = parseRecord(await kv.get(emailKey));
  if (!rec) {
    return expiredPage();
  }

  if (rec.confirmed === true) {
    await kv.delete("token:" + token);
    return page(
      200,
      "Confirmed — HA News",
      "You're already confirmed.",
      "You're already confirmed."
    );
  }

  const exp = rec.tokenExp ? Date.parse(rec.tokenExp) : NaN;
  if (!Number.isFinite(exp) || Date.now() > exp) {
    await kv.delete("token:" + token);
    return expiredPage();
  }

  const now = new Date().toISOString();
  const confirmed = {
    name: rec.name,
    email: rec.email,
    phone: rec.phone,
    ts: rec.ts,
    confirmed: true,
    confirmedAt: now,
  };
  await kv.put(emailKey, JSON.stringify(confirmed));
  await kv.delete("token:" + token);
  return page(
    200,
    "Confirmed — HA News",
    "You're confirmed.",
    "You're confirmed. We'll send the weekday brief when the list goes out. We will not call."
  );
}
