// One-click unsubscribe for the HA News weekday brief.
//
// GET /unsubscribe?e=<email>&s=<unsubToken>
//
// The token is a per-subscriber random value minted at subscribe/confirm time
// and stored in the SUBSCRIBERS KV record (never derivable from the address),
// so the link works from any old email and cannot be forged by guessing
// addresses. Unsubscribing only sets a flag on the record: nothing is deleted,
// and re-subscribing from the homepage clears it via subscribe.js.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function layout(heading, message) {
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "  <title>Unsubscribe — HA News</title>\n" +
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
    '        <p class="kicker">Unsubscribe</p>\n' +
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

function page(status, heading, message) {
  return new Response(layout(heading, message), {
    status: status,
    headers: htmlHeaders(),
  });
}

function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
  const email = String(url.searchParams.get("e") || "").trim().toLowerCase();
  const sig = String(url.searchParams.get("s") || "").trim();

  if (!email || !EMAIL_RE.test(email) || !sig) {
    return page(
      400,
      "Link missing or invalid",
      "This unsubscribe link is missing the address or the signature."
    );
  }

  const kv = env && env.SUBSCRIBERS;
  if (!kv || typeof kv.get !== "function") {
    return page(503, "Temporarily unavailable", "Please try again in a minute.");
  }

  const rec = parseRecord(await kv.get(email));
  if (!rec || !sameToken(String(rec.unsubToken || ""), sig)) {
    return page(
      400,
      "Link missing or invalid",
      "This unsubscribe link does not match our records. Reply to any HA News email and we will remove you by hand."
    );
  }

  if (rec.unsubscribed === true) {
    return page(
      200,
      "You're already unsubscribed",
      "This address is already off the list. Nothing further will be sent."
    );
  }

  const updated = {
    ...rec,
    unsubscribed: true,
    unsubscribedAt: new Date().toISOString(),
  };
  delete updated.token;
  delete updated.tokenExp;
  await kv.put(email, JSON.stringify(updated));

  return page(
    200,
    "You're unsubscribed",
    "This address is off the HA News list and will not receive the daily brief. Re-subscribe from the homepage any time."
  );
}
