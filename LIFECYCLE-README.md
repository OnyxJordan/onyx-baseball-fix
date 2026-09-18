# Onyx Lifecycle Marketing — Session Handoff README

Handoff for continuing Jordan's (jordan@onyxodds.com) lifecycle marketing operation. Two strictly separate product tracks run out of one Customer.io workspace (**171729**). Read this whole file before touching anything: the copy rules, the webhook mechanics, and the "never do" list have all been paid for in incidents.

---

## The two product tracks — never mix them

| | Track 1: Sweeps (NFL26 lifecycle) | Track 2: Onyx Predictions (CFTC) |
|---|---|---|
| Product | Sweepstakes gaming | Real-money event-contract trading via **NJT** (regulated entity, CFTC) |
| Currency in copy | **Onyx Cash / Bonus Picks — NEVER a dollar sign** | **Real USD — dollar signs required.** Credit name is confirmed: **"Promotional Credits"** (welcome flavor: "Bonus Promotional Credits") |
| Exceptions | Streamer program payouts are real USD (that's the sell) | The word "predictions" appears in legal disclaimers only; copy sells sports + Onyx |
| Approval | Jordan starts campaigns | **Nothing schedules until NJT approves it for the CFTC.** Everything is built draft-first |
| Docs | NFL26 Kickoff Ladder ops doc | Predictions Promo Pipeline + Creative Briefs + submission pack docx |

Shared copy rules: no em dashes, hook + one-line offer + 3 steps, terms live in the disclaimer, every material term appears in the email itself. No "risk-free" / "guaranteed" / "free money" / "can't lose" anywhere on either track.

---

## Documents of record (artifacts)

| Doc | URL | State |
|---|---|---|
| NFL26 Kickoff Ladder (sweeps ops doc, source of truth for all sweeps copy blocks) | https://claude.ai/code/artifact/28e2d83b-7b6e-4961-9be2-db117e811c93 | Version 36 |
| Predictions Promo Pipeline (calendar, offer library, season map, submission tracker, all predictions copy) | https://claude.ai/artifact/LTehUUcHe1whF9fN3SFkJ7 | Version 7 |
| Predictions Creative Briefs (graphic descriptions for every predictions campaign) | https://claude.ai/artifact/NS44dCebHgY1K57LomWXGL | Version 1 |
| Onyx Streamer Program one-pager | https://claude.ai/code/artifact/cd5c00ae-c633-4888-a15c-9541751c1641 | Version 2 |
| NJT submission pack (Word doc, delivered to Jordan in chat) | scratchpad: `Onyx-Predictions-Promo-Submission-Pack.docx` (regeneratable via `build_njt_pack.js`) | v1, Sep 17 |
| Notion: Predictions Promo Calendar (database, 10 rows E1–E10) | https://app.notion.com/p/412b9f0b45054131b296f5ae4fc6aa17 · data source `e81dee76-5a0f-4064-9cb9-dcbffeaf0320` | Private page; Jordan hasn't named a team destination yet |

Workflow rule: **copy lives in the artifact docs first**; CIO holds envelopes; Jordan pastes bodies in the Bee editor ("Copy content from another message" → pick a Bee design → paste the block). Edits requested by NJT go into the doc first so the doc always matches what was approved.

---

## THE WEBHOOK SYSTEM (grant pipe) — how bonuses actually get granted

This is the core mechanism connecting Customer.io to the Onyx platform. Everything sweeps-side that grants a bonus flows through it.

1. **Promos live in Postgres** (via Retool, resource **appDatabaseWrite**, id `3d4f2e93-4a9d-4fa4-b9c5-96fc7f94cbe0`, raw SQL via `.query(sql, params)`), table `"Promotion"`. Key columns: `semanticCode` (the exact webhook match key), `type` (`PROFIT_BOOST`, `PURCHASE_MATCH`/FREE_PICKS, `FIRST_TIME_PURCHASE_BONUS`), `betTokenConfiguration` JSON (boosts: `{league?, minLegs, minOdds, maxStakeCents, profitBoostMultiplier}`; purchase match: `{matchPercentage, typeOfMatchBonus:"FREE_PICKS", maxMatchAmountCents}`), `criteria` **always** `{"targetingType":"customUsers"}`, `startsAt`/`endsAt` (UTC; 11:59 PM ET = next-day `03:59:59Z`).
2. **CIO fires the grant** via a `webhook_action` whose template is: `POST https://api.onyxodds.com/api/webhooks/customerio/lifecycle-promo`, header `Content-Type: application/json`, body `{"promotion_codes":["<semanticCode>"],"email":"{{customer.email}}"}`. Clone an existing one (e.g. template 853) when building new handlers.
3. **The classic claim-handler campaign shape** (seg_attr): trigger on audience segment → offer email → `conditional_wait_action` (branch 0 = condition met → webhook grant → exit; branch 1 = timeout → exit). The wait condition is base64-DSL `multi_conditions` — click-to-claim uses `{"type":"message","event":{"name":"output_<emailActionId>","type":"clicked_email"},"inverse":false}`; the verify handler uses `{"type":"attribute","field":"passesSocureDocV","operator":"eq","value":"true"}`.
4. **CRITICAL — the semanticCode incident (Sep 9):** opening and SAVING a promo in the platform's promo admin panel rewrites `semanticCode` and strips the dots, which silently severs the webhook (handler returns 200 for unknown codes and grants nothing). ~214 clickers were affected on launch day; fixed via SQL rename + per-person re-grants. **Never open/save promos in the admin panel. All promo changes via SQL only.** Engineering owes: handler should alert on unknown codes; admin saves should preserve semanticCode.
5. **Per-person re-grant / recovery tool:** `POST /v1/environments/{env}/verify/webhook_template` with `{"template_id":N,"customer_id":"<cio hex id>"}` fires the real webhook for one person; the handler replaces unused grants (no stacking). Retry on Cloudflare 502s until `ok:true`.
6. **Verification signal:** profile attribute `passesSocureDocV` (true = doc-verified). Events also exist: `identity verified`, `document verified`. Event `stream started` was seeded Sep 13 (attrs: platform, streamer_tag, session_id) — production track call still owed by engineering.

---

## Customer.io API mechanics (hard-won; the MCP tools are cio_read_api / cio_write_api / cio_schema / cio_skills_read)

- Campaign updates: `PUT /campaigns/:id` with **`update_type` as a QUERY PARAM** (and echoed in body). `recipients` is a full replace per type — `seg_attr` requires `trigger` (raw JSON object, never a string) + `restart_mode` + `restart_min_interval`. Negation goes **inside** the segment/attribute object: `{"segment":{"id":233,"inverse":true}}`.
- New segment-triggered campaigns must be `type: "seg_attr"` (API rejects new `behavioral`). Create accepts `trigger` but doesn't store it — always follow with a `recipients` PUT and verify with a fresh GET (responses echo stale data).
- `add_actions`: actions top-level with placeholder ids `-1,-2,-3`, edges full-replace, every edge needs `index`. **The placeholder→id mapping has come back REVERSED** — always GET the edges after and fix with `update_type: "edges"` if the graph is wrong (this bit us on campaign 118).
- `delete_actions`: needs top-level `action_ids` array + `name` + the full remaining edge list (with `index`) inside `campaign`.
- Action PUT (`/actions/:id`) is a full replace — echo `multi_conditions`, `preconditions`, `sub_type`, `exit_type` etc. Gates live in `preconditions` (plural).
- Base64 filter encoding everywhere: `base64(encodeURIComponent(JSON))`. Attribute negation in the base64 DSL is a `!` operator prefix, never `inverse`.
- Templates: PUT envelope only (`subject`, `preheader_text`, `name`) — allowed while the campaign is DRAFT, `403 mcp_missing_write_live` once running. **NEVER write email bodies via API** (standing rule; bodies are Bee-editor pastes). Webhook templates (url/body/headers) are config, not email content — fine to write. `has_content: true` only means "not blank," NOT "correct" (the C3/VA3/VB3 offers were flagged done but still held an August CFB clone).
- One-time sends (broadcast system, "newsletters"): `POST /newsletters {name, send_percentage:100}` → PUT `update_type: "channel"` → templates via `GET /newsletters/:id/templates` → envelope PUT. `recipients` needs send_percentage/send_to_unsubscribed/deduped/use_message_limits + base64 `filters`. `schedule` ≠ `send` — `send` fires immediately.
- Campaign LIST endpoint randomly drops rows — always GET by id. Start/stop/delete campaigns = write:live = Jordan in the UI. Snowflake via `POST /snowflake_query`, semantic view `ANALYTICS.CIO_AGENT.sv_deliverability` (members: deliveries.sent / unique_human_opens / unique_human_clicks / unique_converted).

Key segments: 33 New Users · 47 Paid Players · 233 / 266 / 495 standard exclusions (exclude everywhere) · 555 purchasers sync (~1-day lag) · 515/516 NP Convert verified/non-verified non-purchasers · 632 Streamer Program Partners (static).

---

## Track 1 status — Sweeps / NFL26 (as of Thu Sep 18)

- **NFL26 ladder program is over**: all claim windows closed Tue Sep 15, 11:59 PM ET. Rung campaigns **87–104 should all be STOPPED** — verify, rolling segments keep feeding dead offers otherwise. Final performance lives in the ops doc. Notable: boost usage ran ~100% of claims; reminders were the highest-leverage sends.
- **Welcome flow 116** (FREE111): RUNNING. Buy 10 Onyx Cash → 111 Bonus Picks via promo `ftp_111_free_picks` (auto on first purchase, live through Dec 31, no webhook). Emails: D0 t928 / D2 t929 / D5 t930. Day-one: 12,521 sends, 1,440 grants, 345 wagered. Old flow 62 stopped. Open decisions: scrap-or-start Catch Up 111; Long Ditch 112–115 parked on the 50-vs-111 offer call.
- **Campaign 117 — Streamer Onboarding** (draft, queue-ready): fires on add to segment 632; email t937 (body IN); conversion goal `stream started` within 14 days. Ops per partner = add to 632. Steps 1–2 of the email are OBS connect + go live. Confirms open: overlay-link delivery wording, payout cadence (instant/daily/weekly), partners@onyxodds.com inbox. Engineering owes the production `stream started` track call (same identity as other CIO events or conversions silently zero). Trigger note: the 266 exclusion was removed in the UI (233/495 remain) — assumed deliberate.
- **Campaign 118 — Verify Handler** (draft): non-verified players (passesSocureDocV not true, excl 233/266/495) → email t957 "Verify Today, Get a 200% Boost for the Weekend" (**body still blank — paste from ops doc**) → wait 5d for verification → webhook (t958) grants `lifecycle_nfl26_verify_weekend_200_pct_boost` (200% profit boost, any sport, 3+ legs +200, max stake 10 Onyx Cash, ends **Sun Sep 20, 11:59 PM ET**). Jordan: paste body, start with backfill ON, **stop it Sunday night** (evergreen trigger + dated promo). If it performs, rebuild as permanent flow with an evergreen promo.
- Standing engineering flags: admin-panel semanticCode rewrite; handler silent-200 on unknown codes; `includedInUserProfile` aggregation stalled since Jul 15; deliverability posture (openers-first, never-openers 1×/month with 3-strike suppression) post-Georgia-broadcast.

## Track 2 status — Onyx Predictions / NJT / CFTC (as of Thu Sep 18)

- **Live pipeline (first month), all DRAFT one-time sends 429–438 / templates 947–956, channel email, envelopes set, deliberately NO audience and NO schedule until approved.** Front-loaded: P1 Deposit $10→Get $25 (Sep 21–23, E1/E2), P2 Refer-a-Friend $20 each (Sep 24–27, E3/E4), P3 Deposit $25→$15 (Sep 28–Oct 4, E5/E6), quiet week Oct 5–11, P4 Double Referral $40 (Oct 12–18, E7/E8), P5 Deposit $50→$25 World Series (Oct 19–25, E9/E10). Subjects are sports-and-Onyx-forward (e.g., "Put $10 on Onyx, Play With $35 for Week 3").
- **P1/P2/P3 were due to NJT the week of Sep 15 — submission is now the critical path.** Sep 21 window slips if it doesn't move.
- **Offer library** (in the Pipeline doc): 3 format masters × 5 tiers ($10/$25/$50/$75/$100) × 3 copy variations each — Welcome Deposit & Bonus (100% match), Referral ($X each, min friend deposit $10 assumed, cap 5 assumed), Profit Boost (X% up to $Y entry; tiers: weekly 25%/$25, marquee 50%/$50, tentpole 100%/$25). One master approval covers all its tiers/skins.
- **Fall season map** (in the Pipeline doc): NFL weekly, CFB Saturdays, MLB postseason, NHL opening (~Oct 6), NBA opening (~Oct 20), World Series, Halloween, Thanksgiving NFL (Nov 26), Black Friday, Cyber Monday, rivalry week (Nov 28), conference championships, CFP first round, NBA Christmas, New Year. **Midterms Nov 3 = HOLD, no political-market promos without explicit NJT sign-off.**
- **Creative briefs doc** (just published, the last thing completed): trading-language visual system (market cards, YES/NO prices in cents, "settles at $1.00", order tickets, tickers; blue = deposit family, gold = referral, green = boost; NO casino/coins/sweeps imagery; no league marks/player likenesses; "example position" labeling; up-only charts banned), one brief per copy variation (9), 14 event skins, production specs (1200×720 hero @2x, 1080 square/story adapts, `pred_[format]_[variation]_[skin]_[tier]` naming).
- **Six confirms block final submission**: NJT entity + CFTC registration line, credit expiry (14d assumed), referral min deposit + cap, age line (18+ assumed), terms URL, boost mechanic wording + payout form (cash vs credits). Locking these finalizes the docx pack in one pass.
- Audience targeting for predictions sends undecided: full list vs predictions-opt-in segment vs state-filtered. Segments get built once Jordan decides.

## Notion schedule

Database **Predictions Promo Calendar** (URL + data source id in the table above). Properties: Email (title), Send date, Promo (select), Format (select: Deposit match / Referral — "Profit boost" option NOT yet added), Type (Announce/Reminder), Subject, Status (Not started/In progress/Done), Submit by, CIO one-time send, CIO template. Rows E1–E10 mirror the live pipeline and are kept in sync with the artifact and CIO on every change. **Pending Notion work:** add the "Profit boost" Format option and the fall season map rows (NHL/NBA openers, Halloween, Thanksgiving, Black Friday, Cyber Monday, rivalry, championships, CFP, NBA Christmas, New Year); move the page from private to a team space once Jordan names one. Page updates use `notion-update-page` with `date:Send date:start` style keys; select options rename via `notion-update-data-source` ALTER COLUMN (add new option → repoint rows → drop old).

## Where we left off, exactly

The last completed action was publishing the **Predictions Creative Briefs** artifact (Version 1) and this README. The active thread was building out the predictions program for NJT submission. Immediate queue, in order:

1. **Sweeps, time-sensitive:** campaign 118 body paste + start (backfill ON), stop Sunday Sep 20 night; verify 87–104 are stopped; start 117 when Jordan's ready.
2. **Predictions, critical path:** Jordan locks the six confirms → regenerate the submission pack docx clean → submit P1/P2/P3 (+ the three format masters) to NJT. On approval: paste approved bodies into 429–438, set audience + schedule per the calendar.
3. **Notion:** Profit boost option + fall map rows (was explicitly promised, not yet done).
4. **Creative:** hand the briefs doc to design; assets follow the naming convention so they map to pipeline rows.
5. Post-NFL26: wrap-up numbers, next No Brainer broadcast round, deep-lapsed replacement offer, permanent verify-boost flow if 118 performs.
