// Ask Onyx relay (Cloudflare Worker). The site is static, so the AI key cannot live in
// the page: this worker holds it, takes one sentence ("3-leg parlay, NBA points overs,
// minimum odds -200") and returns a SEARCH SPEC as JSON. It never sees prices or picks
// and never chooses plays: ask.js runs the spec against today's boards (our models and
// Onyx's live prices), so an answer can only ever be a real line on the board.
//
// Config (set by .github/workflows/ai_worker.yml, never committed):
//   ANTHROPIC_API_KEY  secret     AI_MODEL  variable     ALLOWED_ORIGINS / AI_FALLBACK  wrangler.toml
import Anthropic from "@anthropic-ai/sdk";

const MARKETS = ["pts", "reb", "ast", "q1_total", "h1_total", "first_basket", "rec", "rec_yds", "rush_yds", "pass_yds",
  "anytime_td", "first_td", "two_plus_td", "spread", "total", "ml"];
const SPORTS = ["nba", "nfl", "cfb", "nhl", "tennis"];

// the same contract ask.js runs (see its header): every field required, null when unsaid
const SPEC = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "count", "sports", "markets", "side", "min_price", "max_price", "min_conf",
    "min_edge", "player", "team", "sort", "one_per_game", "rr_size", "target_price", "count_set", "when", "summary"],
  properties: {
    intent: { type: "string", enum: ["parlay", "sgp", "rr", "list"] },
    count: { type: "integer" },
    sports: { type: "array", items: { type: "string", enum: SPORTS } },
    markets: { type: "array", items: { type: "string", enum: MARKETS } },
    side: { type: "string", enum: ["over", "under", "any"] },
    min_price: { type: ["integer", "null"] },
    max_price: { type: ["integer", "null"] },
    min_conf: { type: ["number", "null"] },
    min_edge: { type: ["number", "null"] },
    player: { type: ["string", "null"] },
    team: { type: ["string", "null"] },
    sort: { type: "string", enum: ["conf", "rec", "edge", "price", "proj", "two_td"] },
    rr_size: { type: ["integer", "null"] },
    target_price: { type: ["integer", "null"] },
    count_set: { type: "boolean" },
    when: { type: ["string", "null"], enum: ["today", "tomorrow", "weekend", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", null] },
    one_per_game: { type: "boolean" },
    summary: { type: "string" },
  },
};

const SYSTEM = `You turn a sports bettor's request into a search spec for Onyx Sports. You do not pick plays; a program runs your spec against today's priced board.

Fields:
- intent: "sgp" for a same-game parlay or correlated legs from one game (SGP), "parlay" for any other ticket of combined legs, including an SGP+ (same-game legs plus other games; the program fills short tickets from games already used), else "list".
- count: legs for a parlay or SGP (default 3), else how many plays to show (default 5; 1 when they ask for "the" single most likely player or play).
- sports: any of nba, nfl, cfb (college football), nhl, tennis. Empty = every sport.
- markets: pts, reb, ast (NBA points, rebounds, assists), q1_total (NBA 1st-quarter total), rec (NFL receptions), rec_yds, rush_yds, pass_yds, anytime_td, two_plus_td (2 or more touchdowns), spread, total, ml (moneyline / to win). Empty = all.
- side: "over" or "under" when they say so, else "any".
- min_price / max_price: American odds bounds on each play. "minimum odds -200", "nothing worse than -200", "no juicier than -200" mean min_price -200 (a -250 leg is excluded, -150 and +120 are fine). "plus money" or "underdogs" mean min_price 100. "+300 or shorter" means max_price 300. Null when unsaid.
- min_conf: a win-chance floor as a fraction (e.g. "70% or better" = 0.7), null when unsaid.
- min_edge: only when they ask for value against the line ("beats the line by 3 points" = 0.03); otherwise null.
- player / team: a named player or team (team as its usual abbreviation, e.g. BOS), else null.
- sort: "conf" for most likely / safest / locks (default), "rec" for what Onyx recommends / its favorites / best picks / what should I bet, "edge" for the most value / where the model beats the line, "price" for the biggest payouts / longshots, "two_td" whenever they ask about 2+ touchdowns.
- For an SGP on a named game or team, put the team in "team".
- intent "rr" for a round robin; rr_size is the combination size ("by 2s" = 2, default 2) and count the number of picks (default 4).
- target_price: a payout they want the whole ticket to reach ("parlay that pays +500" = 500), else null. count_set: true only when they named a number of legs or picks.
- when: "today" for tonight / today, "tomorrow", "weekend", or a weekday name; null when unsaid.
- sort "proj" for who will score / catch / rush / rebound the most (the highest projection).
- first_td (first touchdown scorer), first_basket (NBA first basket), h1_total (NBA 1st-half total).
- one_per_game: true unless they explicitly want several plays from the same game.
- summary: one short plain sentence saying what you understood, no odds advice.

If the request is not about sports plays, return intent "list", count 5, empty sports and markets, sort "conf", and say in summary that you showed today's most likely plays.`;

// a light per-instance throttle; the real cost cap is the spend limit on the AI account
const HITS = new Map();
function throttled(ip) {
  const now = Date.now(), win = HITS.get(ip) || [];
  const recent = win.filter((t) => now - t < 60000);
  recent.push(now);
  HITS.set(ip, recent);
  return recent.length > 12;
}

function cors(origin, env) {
  const ok = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    "access-control-allow-origin": ok.includes(origin) ? origin : ok[0] || "null",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "vary": "origin",
  };
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export default {
  async fetch(req, env) {
    const h = cors(req.headers.get("origin") || "", env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method === "GET") return json({ ok: true, service: "onyx-ask" }, 200, h);
    if (req.method !== "POST") return json({ error: "method" }, 405, h);
    if (!env.ANTHROPIC_API_KEY || !env.AI_MODEL) return json({ error: "not configured" }, 503, h);
    if (throttled(req.headers.get("cf-connecting-ip") || "?")) return json({ error: "slow down" }, 429, h);

    let q = "";
    try { q = String((await req.json()).q || "").trim().slice(0, 300); } catch { /* empty body */ }
    if (!q) return json({ error: "empty" }, 400, h);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 20000 });
    const params = {
      model: env.AI_MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: "user", content: q }],
      output_config: { effort: "low", format: { type: "json_schema", schema: SPEC } },
    };
    try {
      const msg = env.AI_FALLBACK === "on"
        ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
        : await client.messages.create(params);
      if (msg.stop_reason === "refusal") return json({ error: "declined" }, 422, h);
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const spec = JSON.parse(text);
      return json({ spec }, 200, h);
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) return json({ error: "busy" }, 429, h);
      if (e instanceof Anthropic.APIError) return json({ error: "ai " + (e.status || "error") }, 502, h);
      return json({ error: "bad answer" }, 502, h);   // unparseable output: ask.js falls back to its own parser
    }
  },
};
