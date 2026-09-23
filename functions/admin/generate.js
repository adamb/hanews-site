import { adminErrorResponse, isAuthed } from "./_lib.js";

const MODEL = "qwen3.5:397b";
const OLLAMA_URL = "https://ollama.com/v1/chat/completions";
const TIMEOUT_MS = 60_000;
const MAX_REQ_BYTES = 4_096;
const MAX_RAW = 64_000;
const MAX_BODY = 12_000;
const MAX_FIELD = 2_000;

const SYSTEM_PROMPT =
  "You are the HA News writer. HA News (hanews.org) covers home automation — the local stack, from radio to automations. Home Assistant is a section of the paper, not the beat and not the paper name.\n" +
  "Use only the facts in the user message. Do not invent specifications, quotes, shipping dates, prices beyond what is given, or unnamed sources.\n" +
  "Write a news post and return JSON only, with these keys: headline, dek, what_happened, why_it_matters, why_local_first, primary_source_url.\n" +
  "No markdown, no HTML, no extra keys, no chain-of-thought.";

const SOURCE_PACKET =
  "Source packet — ESPHome Starter Kit facts already on the HA News 15 Aug 2026 sample edition. Use only these facts.\n\n" +
  "- On 12 August 2026 the ESPHome blog published ESPHome's first official product: a starter kit.\n" +
  "- The kit was teased in April 2026 at State of the Open Home.\n" +
  "- Designed and produced by Apollo Automation, the Open Home Foundation's second commercial partner.\n" +
  "- The majority of profit from each kit goes to the Open Home Foundation.\n" +
  "- The kit arrives as a snap-apart panel: an ESP32-C6 board plus four modules.\n" +
  "- Modules: motion (PIR; MH-SR602 on Apollo's bill of materials); temperature and humidity (AHT20F); a button; a notification board (piezo/buzzer plus ten RGB LEDs behind the ESPHome logo, plus a stand).\n" +
  "- Modules connect with flat FPC ribbon cables; a spare is in the box. No soldering, no breadboard.\n" +
  "- USB-C power. Optional LiPo is documented by Apollo, not required to start.\n" +
  "- The board is ESP32-C6-MINI-1 with Wi-Fi, Bluetooth LE, and Thread. Two 14-pin FPC ports. Two modules at a time is the intended multisensor setup.\n" +
  "- It talks to Home Assistant, or runs as a standalone local device. No cloud account is required for the device to run.\n" +
  "- Configuration is the ESPHome Device Builder desktop app. Visual editor; YAML remains. The Learning Wiki is the other half of onboarding.\n" +
  "- Price and retailer lists belong to Apollo's product page, not this brief. Apollo's store lists $40 USD direct; that is their store, not this paper's rate card.\n" +
  "- Primary source URL: https://esphome.io/blog/2026/08/12/the-esphome-starter-kit-is-here/\n" +
  "- Public sample edition date: 15 Aug 2026.\n";

function ollamaKey(env) {
  const v = env && env.OLLAMA_API_KEY;
  return typeof v === "string" ? v.trim() : "";
}

function clip(value, max) {
  const s = String(value == null ? "" : value).trim();
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function extractJson(text) {
  let s = String(text || "").trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function formatDate(d) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Puerto_Rico",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(d);
  const map = {};
  for (let i = 0; i < parts.length; i++) {
    map[parts[i].type] = parts[i].value;
  }
  return (map.day || "") + " " + (map.month || "") + " " + (map.year || "");
}

function assembleBody(parsed) {
  const headline = clip(pick(parsed, ["headline", "title"]), MAX_FIELD);
  const dek = clip(pick(parsed, ["dek", "lede"]), MAX_FIELD);
  const happened = clip(
    pick(parsed, ["what_happened", "what happened"]),
    MAX_FIELD
  );
  const matters = clip(
    pick(parsed, ["why_it_matters", "why it matters"]),
    MAX_FIELD
  );
  const localFirst = clip(
    pick(parsed, [
      "why_local_first",
      "why a local-first reader cares",
      "why_local_first_reader_cares",
    ]),
    MAX_FIELD
  );
  const source = clip(
    pick(parsed, ["primary_source_url", "primary source URL", "primary_source"]),
    MAX_FIELD
  );
  const parts = [];
  if (headline) parts.push(headline);
  if (dek) parts.push(dek);
  if (happened) parts.push("What happened\n" + happened);
  if (matters) parts.push("Why it matters\n" + matters);
  if (localFirst) parts.push("Why a local-first reader cares\n" + localFirst);
  if (source) parts.push("Primary source URL\n" + source);
  return {
    title: headline || "ESPHome Starter Kit",
    body: clip(parts.join("\n\n"), MAX_BODY),
  };
}

export async function handleGenerate(context) {
  if (!(await isAuthed(context))) {
    return adminErrorResponse(401, "Sign in required.");
  }

  const env = context.env;
  const key = ollamaKey(env);
  if (!key) {
    return adminErrorResponse(
      503,
      "OLLAMA_API_KEY is not set. Add it as a Cloudflare Pages secret. Drafts cannot be generated without it."
    );
  }

  const kv = env && env.SUBSCRIBERS;
  if (!kv || typeof kv.put !== "function") {
    return adminErrorResponse(
      503,
      "Subscriber KV is not bound, so the draft cannot be stored."
    );
  }

  const len = Number(context.request.headers.get("Content-Length") || "0");
  if (Number.isFinite(len) && len > MAX_REQ_BYTES) {
    return adminErrorResponse(413, "Request is too large.");
  }

  let upstream;
  try {
    upstream = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        temperature: 0.3,
        max_tokens: 2500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: SOURCE_PACKET },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut =
      err && (err.name === "TimeoutError" || err.name === "AbortError");
    return adminErrorResponse(
      timedOut ? 504 : 502,
      timedOut
        ? "Draft generation timed out."
        : "Could not reach Ollama Cloud."
    );
  }

  let raw = "";
  try {
    raw = await upstream.text();
  } catch {
    return adminErrorResponse(502, "Ollama Cloud did not return a draft.");
  }
  if (raw.length > MAX_RAW) raw = raw.slice(0, MAX_RAW);

  if (!upstream.ok) {
    return adminErrorResponse(502, "Ollama Cloud did not return a draft.");
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return adminErrorResponse(502, "Writer returned unreadable copy.");
  }

  const content =
    payload &&
    payload.choices &&
    payload.choices[0] &&
    payload.choices[0].message
      ? payload.choices[0].message.content
      : "";
  const parsed = extractJson(content);
  if (!parsed) {
    return adminErrorResponse(502, "Writer returned unreadable copy.");
  }

  const assembled = assembleBody(parsed);
  const ts = new Date();
  const id = crypto.randomUUID();
  const record = {
    id: id,
    title: assembled.title,
    type: "news post",
    status: "Draft",
    date: formatDate(ts),
    body: assembled.body,
    model: MODEL,
    ts: ts.toISOString(),
  };

  try {
    await kv.put("draft:" + id, JSON.stringify(record));
  } catch {
    return adminErrorResponse(503, "Could not store the draft.");
  }

  return new Response(null, {
    status: 303,
    headers: {
      Location: "/admin",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestPost(context) {
  return handleGenerate(context);
}
