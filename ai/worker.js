// Ask Onyx relay (Cloudflare Worker, OpenAI). The site is static, so the AI key cannot live in
// the page: this worker holds it. Two jobs, and in neither does the AI choose plays:
//   POST {q, ctx}        one sentence (plus the previous answer, for follow-ups like "swap leg 2"
//                        or "make it +500") -> {spec, say}. ask.js runs the spec against today's
//                        boards (our models and Onyx's live prices), so a play is always a real line.
//   POST {explain: {...}} the legs ask.js already chose, with their numbers -> {text}: a short,
//                        plain read on why, using only those numbers.
//
// Config (set by .github/workflows/ai_worker.yml, never committed):
//   OPENAI_API_KEY  secret     AI_MODEL  variable     ALLOWED_ORIGINS  wrangler.toml

const MARKETS = ["pts", "reb", "ast", "q1_total", "h1_total", "first_basket", "first_td", "rec", "rec_yds", "rush_yds",
  "pass_yds", "pass_td", "pass_att", "rush_rec_yds", "pass_rush_yds", "anytime_td", "two_plus_td", "spread", "total", "ml"];
const SPORTS = ["nba", "nfl", "cfb", "nhl", "tennis"];
const OPENAI = "https://api.openai.com/v1/chat/completions";

// the same contract ask.js runs (see its header): every field required, null when unsaid
const SPEC = {
  type: "object",
  additionalProperties: false,
  required: ["intent", "count", "sports", "markets", "side", "min_price", "max_price", "min_conf",
    "min_edge", "player", "team", "teams", "sort", "one_per_game", "rr_size", "target_price", "count_set", "when",
    "exclude", "summary", "say", "clarify"],
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
    teams: { type: "array", items: { type: "string" } },
    sort: { type: "string", enum: ["conf", "rec", "edge", "price", "proj", "two_td"] },
    rr_size: { type: ["integer", "null"] },
    target_price: { type: ["integer", "null"] },
    count_set: { type: "boolean" },
    when: { type: ["string", "null"], enum: ["today", "tomorrow", "weekend", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", null] },
    one_per_game: { type: "boolean" },
    exclude: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    say: { type: "string" },
    clarify: {
      anyOf: [
        { type: "null" },
        {
          type: "object", additionalProperties: false, required: ["question", "options"],
          properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } },
        },
      ],
    },
  },
};
const EXPLAIN = {
  type: "object", additionalProperties: false, required: ["text"],
  properties: { text: { type: "string" } },
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
- pass_td (passing TDs), pass_att (pass attempts), rush_rec_yds (rushing + receiving yards), pass_rush_yds (passing + rushing yards).
- teams: when they name two or more teams ("from the Chiefs, Broncos, Patriots or Dolphins"), every one of them as ESPN abbreviations (KC, DEN, NE, MIA, WSH, JAX, LAR, LAC, GB, NO, SF, TB, NYG, NYJ, LV); then team is null. One team goes in team and teams is empty. Never drop a team they named.
- clarify: null almost always. Set it only when guessing would give them the wrong thing: (a) two very different readings are equally likely, (b) something we do not price (a sport other than nba, nfl, cfb, nhl, tennis; a market not listed). Then question is one short, friendly question that says what you can do, and options are 2 to 4 complete requests they can tap, each one a full sentence the program can run on its own (e.g. "3 leg anytime TD parlay from tonight's games", "3 leg anytime TD parlay from KC, DEN, NE or MIA next week"). Still fill every other field with your best reading. Do not ask just because they say "live" or "in-game": the page shows our live numbers for the games being played by itself; fill the sport and teams they named.
- exclude: names of players or teams to leave out ("not Mahomes", "swap out Irving", "replace leg 2" = the name on leg 2 of the previous answer). Empty when unsaid.
- summary: one short plain sentence saying what you understood, no odds advice.
- say: one or two friendly sentences back to the bettor, as a sharp friend would talk, saying what you are building for them. Never invent a player, price or stat; the program picks the plays. No em dashes. Never name a sportsbook other than Onyx.

Conversation: you may get the previous request, its spec and the legs it returned. If the new message changes that answer ("make it +500", "swap leg 2", "only NBA", "one more leg", "same but unders", "what about tomorrow"), start from the previous spec and change only what they asked. If it is a new request, ignore the previous one.

Our built-in reader: you may also get "Built-in reading", the spec our own parser made from the same message (tested on 500 real phrasings). Start from it. Keep every field it got right, and change a field only when the message clearly means something else (a name it missed or mangled, slang, a follow-up it could not see). It is usually right about prices, markets and counts.

Lessons from testing (follow these):
- "favorite", "your favorites", "who do you like", "best bets", "what should I bet" mean sort "rec". For touchdown scorers that ranks by how much our TD model likes them against their price, which is what "favorite TD scorers" means; never treat it as "shortest odds".
- "best value" or "most value" for touchdown scorers: sort "edge" (the program ranks TD value by the TD model).
- A price ceiling: "no odds longer than -150", "nothing longer than +200", "shorter than -120", "-150 or shorter" mean max_price (the longest price allowed). A bare negative price like "-150 odds" with no other word is a ceiling too.
- The word "odds" alone is not a price floor. Only "minimum odds X", "no worse than X", "no shorter than X", "no juicier than X" set min_price.
- "players to score", "picks to score today", "who scores a TD" mean anytime_td (football), not points, unless points, goals or runs are named.
- Do not set min_conf unless they give a percentage; the program already keeps every leg 50%+ unless they ask for dogs, longshots, touchdown scorers or a payout.
- A college player (e.g. Jeremiah Smith, Ohio State) is sport cfb; an NFL player with a similar name (Geno Smith) is nfl. Use the full name they typed.

Loose phrasing is normal: "who's hot", "give me something safe for tonight", "sweat me a dog", "your favorites to score" (anytime_td, sort rec), "best bets" (sort rec). Read the intent, not keywords.

If the request is not about sports plays, return intent "list", count 5, empty sports and markets, sort "conf", and say in summary that you showed today's most likely plays.`;

const EXPLAIN_SYSTEM = `You explain a bettor's Onyx Sports answer in two to four short sentences, like a sharp friend, using ONLY the numbers given for each leg:
- conf: the chance the play wins as shown (each sport's model blended with Onyx's price); price: Onyx's American odds; edge: conf minus Onyx's implied chance, in points.
- model: for touchdown scorers, the TD model's own chance before blending (the shown chance is Onyx's price less its margin, because the TD model has not beaten Onyx's prices in testing).
- tag: "tracked" = a graded pick on the public record, "trial" = logged at Onyx's opening price while it is tested, "lean" = the model's read, not graded.
- proj / line: the model's projection against the line, when given.
How to read them: a leg is good when its chance (conf, or model for a touchdown scorer) beats the chance Onyx's price implies. For touchdown scorers every edge is negative because TD prices carry a big margin; do not dwell on it, compare the TD model's chance with the price instead (e.g. "the model has him at 57%, the price implies 59%" or "model 37% at +260, which implies 28%"). Write chances as percents ("57%"). Pick the one or two numbers that matter, do not recite every field.
Say which leg you like most and why, and be honest about the weakest one, the way a sharp friend would at the bar, not like a report. Never invent stats, injuries, news or players. Never promise a win. No em dashes. Never name a sportsbook other than Onyx. Plain text, no lists.`;

// a light per-instance throttle; the real cost cap is the monthly budget on the OpenAI account
const HITS = new Map();
function throttled(ip) {
  const now = Date.now(), win = HITS.get(ip) || [];
  const recent = win.filter((t) => now - t < 60000);
  recent.push(now);
  HITS.set(ip, recent);
  return recent.length > 20;
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
const clean = (s) => String(s || "").replace(/\s*[—–]\s*/g, ", ").replace(/DraftKings|FanDuel|BetMGM|Caesars/gi, "Onyx").trim();
const cut = (x, n) => JSON.stringify(x == null ? null : x).slice(0, n);

// one structured call; throws {status} on an API error
async function chat(env, system, user, name, schema, maxTokens) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(OPENAI, {
      method: "POST",
      signal: ctl.signal,
      headers: { "authorization": `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.AI_MODEL,
        max_completion_tokens: maxTokens,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
      }),
    });
    if (!r.ok) throw { status: r.status };
    const j = await r.json();
    const m = j.choices && j.choices[0] && j.choices[0].message;
    if (!m || m.refusal) throw { status: 422 };
    return JSON.parse(m.content);
  } finally {
    clearTimeout(tm);
  }
}

export default {
  async fetch(req, env) {
    const h = cors(req.headers.get("origin") || "", env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    if (req.method === "GET") return json({ ok: true, service: "onyx-ask" }, 200, h);
    if (req.method !== "POST") return json({ error: "method" }, 405, h);
    if (!env.OPENAI_API_KEY || !env.AI_MODEL) return json({ error: "not configured" }, 503, h);
    if (throttled(req.headers.get("cf-connecting-ip") || "?")) return json({ error: "slow down" }, 429, h);

    let body = {};
    try { body = await req.json(); } catch { /* empty body */ }
    try {
      if (body.explain) {
        const x = body.explain;
        const user = `Request: ${String(x.q || "").slice(0, 300)}\nTicket: ${cut(x.ticket, 300)}\nLegs: ${cut(x.legs, 3000)}\nNote shown: ${String(x.note || "").slice(0, 400)}`;
        const out = await chat(env, EXPLAIN_SYSTEM, user, "explain", EXPLAIN, 1500);
        return json({ text: clean(out.text).slice(0, 700) }, 200, h);
      }
      const q = String(body.q || "").trim().slice(0, 300);
      if (!q) return json({ error: "empty" }, 400, h);
      const cx = body.ctx;
      const hint = body.hint ? `\nBuilt-in reading: ${cut(body.hint, 1500)}` : "";
      const user = (cx && cx.q
        ? `Previous request: ${String(cx.q).slice(0, 300)}\nPrevious spec: ${cut(cx.spec, 1500)}\nPrevious legs (in order): ${cut(cx.legs, 1200)}\n\nNew message: ${q}`
        : `Message: ${q}`) + hint;
      const spec = await chat(env, SYSTEM, user, "spec", SPEC, 2000);
      const say = clean(spec.say);
      const c = spec.clarify && spec.clarify.question && (spec.clarify.options || []).length
        ? { question: clean(spec.clarify.question), options: spec.clarify.options.slice(0, 4).map(clean) } : null;
      delete spec.say;
      delete spec.clarify;
      return json({ spec, say, clarify: c }, 200, h);
    } catch (e) {
      const st = e && e.status;
      if (st === 429) return json({ error: "busy" }, 429, h);
      if (st) return json({ error: "ai " + st }, 502, h);
      return json({ error: "bad answer" }, 502, h);   // unparseable or timed out: ask.js falls back to its own parser
    }
  },
};
