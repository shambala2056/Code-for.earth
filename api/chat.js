import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./_knowledge.js";

// Sooton chat: the page posts the conversation, we stream Claude's reply back as plain text.
const client = new Anthropic();
const MAX_TURNS = 20, MAX_CHARS = 1500;
const hits = new Map(); // best-effort per-IP limit (per warm instance)

function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < win);
  list.push(now); hits.set(ip, list);
  return list.length > 30;
}

function clean(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw.slice(-MAX_TURNS)
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return null;
  // merge accidental same-role neighbours so roles alternate
  return msgs.reduce((out, m) => {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content; else out.push({ ...m });
    return out;
  }, []);
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "method" }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(503).json({ error: "not_configured" }); return; }
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
  if (limited(ip)) { res.status(429).json({ error: "rate_limited" }); return; }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const messages = clean(body.messages);
  if (!messages) { res.status(400).json({ error: "bad_request" }); return; }
  const lang = body.lang === "en" ? "English" : "Mongolian";

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
  try {
    const stream = client.beta.messages.stream({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      system: [
        { type: "text", text: SYSTEM_PROMPT },
        { type: "text", text: `The visitor's page is currently set to ${lang}.` },
      ],
      messages,
    });
    stream.on("text", (t) => res.write(t));
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") {
      res.write(lang === "English" ? "Sorry, I can't help with that one. Ask me anything about our websites and branding 🙂" : "Уучлаарай, үүнд тусалж чадахгүй нь. Вэб сайт, брэндингийн талаар юу ч асуугаарай 🙂");
    }
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) console.error("chat: rate limited");
    else if (err instanceof Anthropic.AuthenticationError) console.error("chat: bad API key");
    else if (err instanceof Anthropic.APIError) console.error(`chat: API error ${err.status}`, err.message);
    else console.error("chat:", err);
    res.write("\n[[ERROR]]");
  }
  res.end();
}
