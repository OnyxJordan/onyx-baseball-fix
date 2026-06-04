# ── 8. STATCAST L14 — FIXED ───────────────────────────────────────────────────
# Root cause: Savant detail CSV = one row per PITCH, not per PA.
# Fix: only count terminal events (PA-ending) for PA/HR totals.
# Also track ev/barrel per batted ball event only.

PA_EVENTS = {
    "home_run","single","double","triple","field_out","strikeout",
    "walk","hit_by_pitch","grounded_into_double_play","fielders_choice",
    "fielders_choice_out","force_out","sac_fly","sac_bunt",
    "double_play","triple_play","strikeout_double_play","sac_fly_double_play",
    "other_out","field_error","catcher_interf","intent_walk",
}

def fetch_statcast():
    print("Fetching Statcast L14 hitter data...")
    today = datetime.date.today()
    start = (today - datetime.timedelta(days=14)).strftime("%Y-%m-%d")
    end   = today.strftime("%Y-%m-%d")
    url = (
        f"https://baseballsavant.mlb.com/statcast_search/csv"
        f"?all=true&player_type=batter&hfGT=R%7C&hfSea=2026%7C"
        f"&game_date_gt={start}&game_date_lt={end}"
        f"&min_abs=5&group_by=name&sort_col=pitches&sort_order=desc&type=details&"
    )
    statcast = {}
    try:
        r = requests.get(url, timeout=60)
        r.raise_for_status()
        reader = csv.DictReader(io.StringIO(r.text))
        agg = defaultdict(lambda: {
            "pa": 0, "hr": 0, "ev_sum": 0, "ev_n": 0,
            "barrels": 0, "hard_hits": 0, "hits": 0
        })
        for row in reader:
            raw = (row.get("player_name", "") or "").strip()
            if not raw:
                continue
            if "," in raw:
                last, first = raw.split(",", 1)
                name = f"{first.strip()} {last.strip()}".lower()
            else:
                name = raw.lower()

            events  = row.get("events", "") or ""
            ev_s    = row.get("launch_speed", "") or ""
            la_s    = row.get("launch_angle", "") or ""

            # ── Only count terminal PA events ──────────────────────────────
            if events in PA_EVENTS:
                agg[name]["pa"] += 1
                if events == "home_run":
                    agg[name]["hr"] += 1
                if events in ("single", "double", "triple", "home_run"):
                    agg[name]["hits"] += 1

            # ── Batted ball metrics (any pitch with launch data) ───────────
            try:
                ev = float(ev_s)
                la = float(la_s)
                agg[name]["ev_sum"] += ev
                agg[name]["ev_n"]   += 1
                if ev >= 95:
                    agg[name]["hard_hits"] += 1
                if ev >= 98 and 26 <= la <= 30:
                    agg[name]["barrels"] += 1
            except:
                pass

        for name, d in agg.items():
            pa = max(d["pa"], 1)
            statcast[name] = {
                "l14_pa":          d["pa"],
                "l14_hr":          d["hr"],
                "l14_rate":        round(d["hr"] / pa, 4),
                "l14_avg_ev":      round(d["ev_sum"] / d["ev_n"], 1) if d["ev_n"] else 90.0,
                "l14_barrel_pct":  round(d["barrels"] / pa, 4),
                "l14_hh_pct":      round(d["hard_hits"] / pa, 4),
                "l14_hit_rate":    round(d["hits"] / pa, 4),
            }

    except Exception as e:
        print(f"  Statcast error: {e}")

    print(f"  Statcast hitters: {len(statcast)}")
    with open(OUT / "statcast_l14.json", "w") as f:
        json.dump(statcast, f, indent=2)
    return statcast
