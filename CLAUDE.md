# Onyx Baseball — operating rules

Daily MLB home-run analytics PWA. Static site, zero servers: a Python pipeline injects
JSON globals into the hand-tuned `shell.html` to build `index.html`, GitHub Actions
deploys to Pages. **Parlays are the product** — everything funnels to app.onyxodds.com
(referral `KR680261`).

Read [README.md](README.md) before non-trivial work. It carries the full architecture,
the model's evidence base, the ledger semantics, the incident playbook, and the known
gaps. This file is the short form that must never be violated.

## Hard rules

1. **Never regenerate `shell.html`, `career_db.json`, or `pitcher_db.json`.** Surgical
   edits only. Months of hand-tuning live in these files.
2. **Every model change bumps the version in `model.py` and adds a changelog entry at
   the top citing its evidence.** The changelog is the lab notebook, not a formality.
3. **All odds are labeled "Onyx."** Never DraftKings/FanDuel branding on the site.
4. **No em dashes in site copy. No yellow anywhere** (Spark tones excluded). Applies to
   rendered copy, not repo docs.
5. **Any injected JS global read before its declaration line must be `var`.** A `typeof`
   guard does NOT protect a `const` in its temporal dead zone — it throws
   `Cannot access 'X' before initialization`, which blanked the whole site on 8/8.
   `index.html` is a single `<script>` block (~2434-7004), so every global shares one
   scope and declaration order is what decides. Check the audit table in
   README → Injected globals, and add any new typeof-guarded global to it.
6. **The ledgers are sacred.** `data/picks_input.json`, `ticket_history.json`,
   `k_history.json`, `hr_history.json` are the public graded record. Never regenerate
   them. During merges: `git checkout origin/main -- data/<ledger>`. Record odds at the
   moment a play qualifies, not later.
7. **Never put the AI model ID in anything pushed to the repo** — commits, PR bodies,
   comments, code. Chat replies only.
8. **Verify headless before shipping any shell change.** The one time this was skipped,
   the site went blank.

## Before you conclude something is broken

- **Published record ≠ raw JSON.** `k_history.json` and `hr_history.json` keep every row;
  the site displays only conviction-qualified rows (K: projection beats line by >10%;
  HR edge: >1.5pp). Apply the filter before reporting a discrepancy.
- **`SEASON_SPLITS loaded (0 players)` is expected.** `data/splits.json` has been empty
  since the manual CSVs were retired; the model falls back to career splits. Not a bug.
- **"Site is stale" is usually GitHub, not the model.** Check the Actions tab first.
  The universal fix is "Run workflow" on `refresh_build.yml`, which also re-seeds the
  self-driving chain.
- **"Model is broken, no plays"** — check calibration buckets and the league weekly HR
  rate before touching weights. On 9/6 it was variance; the model was calibrated.

## Dates

Everything runs on the **baseball day = ET − 4h** (rolls at 4 AM ET). Never date anything
off UTC "today" — a 9 PM ET build once ran on the runner's UTC date and seeded phantom
next-day rows into all four ledgers.

## Workflow

Work on a `claude/...` branch, PR to `main`, squash-merge. `main` moves under you every
~35 minutes (the chain commits), so expect conflicts on `index.html` and `data/` — take
`--theirs` for `index.html`, `origin/main` for `data/`, keep your own source files, then
rebuild. Full ritual in the README.

Verification before shipping shell or model changes:

```bash
rm -rf __pycache__ && python3 -B auto_build.py && python3 -B update_stats.py
npm install playwright-core --no-save   # once per container
node tools/verify_shell.js              # local build; exits non-zero on failure
node tools/verify_shell.js --live       # the DEPLOYED page, after the deploy lands
```

Use that script rather than writing a probe from scratch — it encodes three things
that are easy to get wrong: tabs must be switched with `gotoTab()` (there are **9**,
and several are hidden in the hamburger drawer at 390px, so clicking nav silently
skips them), every off-origin request must be aborted or it hangs on Google Fonts,
and `--live` cannot navigate to `https://` from a cloud session (the agent proxy's
CA is not trusted by Chromium — it curls the bytes and serves them locally; never
disable certificate checking to work around this).

A green build is not a shipped fix: verify the deployed page separately, because
Pages deploys lag the commit.

The daily pipeline depends on `requests` only — do not add imports to it casually.
`tools/` is dev-only and never runs in the pipeline.

## Working with Jordan

Marketing lead, non-engineer, sharp instincts. His gut reports have almost always pointed
at real bugs — verify with data and show receipts, in plain language with the numbers
that matter. Trust his screenshots over your assumptions. Priorities: parlays funnel
first, honest public records always, purple brand, PWA experience.
