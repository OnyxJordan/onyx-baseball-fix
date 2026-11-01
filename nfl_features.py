#!/usr/bin/env python3
"""
nfl_features.py - the statistics behind the NFL v11 market models, computed from what
was known before kickoff. One file, used by both the backtest
(tools/nfl_feature_screen.py) and the live build (sports_build.py), so the model runs
on exactly the numbers it was tested on.

Input: nflverse weekly player stats (one row per player-game; nfl_verse.py keeps
them in data/nfl/nflverse.json as "wk") and nflverse snap shares. Stdlib only.
"""
import re, unicodedata
from collections import defaultdict

# nflverse stats_player_week columns the features read, in storage order
FIELDS = ("completions", "attempts", "passing_yards", "passing_tds", "passing_epa", "passing_cpoe", "passing_air_yards",
          "sacks_suffered", "carries", "rushing_yards", "rushing_tds", "rushing_epa", "receptions", "targets",
          "receiving_yards", "receiving_tds", "receiving_air_yards", "receiving_yards_after_catch", "receiving_epa",
          "target_share", "air_yards_share", "wopr", "racr")
HEAD = ("season", "week", "team", "opp", "pid", "key", "pos")
# Onyx market (our key) -> the nflverse number it settles on
STAT = {"rec": "receptions", "rec_yds": "receiving_yards", "rush_yds": "rushing_yards", "pass_yds": "passing_yards",
        "pass_att": "attempts", "pass_td": "passing_tds", "rush_rec_yds": "rush_rec_yds", "pass_rush_yds": "pass_rush_yds"}
# plain-English names, for "why the model got there"
LABEL = {"l3": "last 3 games", "l5": "last 5 games", "season": "season average", "line_vs_l5": "line vs his last 5",
         "line_vs_season": "line vs his season average", "line_z": "line vs his usual range", "trend": "recent trend",
         "sd8": "game-to-game swings", "cv8": "consistency", "tgt_share": "target share", "air_share": "air-yards share",
         "wopr": "weighted opportunity", "tgt_l3": "targets, last 3", "tgt_trend": "target trend", "adot": "depth of target",
         "yac_rec": "yards after catch per catch", "catch_rate": "catch rate", "ypt": "yards per target",
         "rec_epa_t": "receiving efficiency (EPA per target)", "racr": "air-yards conversion", "carries_l3": "carries, last 3",
         "ypc": "yards per carry", "rush_epa_c": "rushing efficiency (EPA per carry)", "carry_share": "carry share",
         "att_l3": "pass attempts, last 3", "pass_epa_db": "passing efficiency (EPA per dropback)", "cpoe": "completion % over expected",
         "pass_adot": "passing depth (air yards per attempt)", "team_pass_rate": "team pass rate", "team_plays": "team plays per game",
         "implied": "Onyx implied team points", "spread": "Onyx spread", "home": "home field", "week": "week of season",
         "opp_pass_yds": "opponent passing yards allowed", "opp_rush_yds": "opponent rushing yards allowed",
         "opp_rec": "opponent catches allowed", "opp_pass_epa": "opponent pass defense (EPA)", "opp_rush_epa": "opponent run defense (EPA)",
         "opp_sacks": "opponent sacks", "games_played": "games played", "snap_avg": "snap share", "snap_last": "last snap share",
         "snap_trend": "snap trend", "weeks_since": "weeks since last game"}


def nk(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", s))


def _num(x):
    try:
        return float(x) if x not in ("", "NA", None) else 0.0
    except ValueError:
        return 0.0


def compact(r):
    """One nflverse CSV row -> a storage list (HEAD + FIELDS), or None for a row with no offense."""
    vals = [round(_num(r.get(k)), 4) for k in FIELDS]
    pos = r.get("position_group") or r.get("position") or ""
    if pos not in ("QB", "RB", "WR", "TE") and not any(vals):
        return None
    return [int(r["season"]), int(r["week"]), r["team"], r["opponent_team"], r["player_id"], nk(r["player_display_name"]), pos] + vals


def expand(row):
    g = dict(zip(FIELDS, row[len(HEAD):]))
    g["rush_rec_yds"] = g["rushing_yards"] + g["receiving_yards"]
    g["pass_rush_yds"] = g["passing_yards"] + g["rushing_yards"]
    g.update(zip(HEAD, row[:len(HEAD)]))
    return g


class Index:
    """Weekly stats and snap shares, indexed for pre-kickoff feature lookups."""

    def __init__(self, rows, snaps):
        rows = sorted((expand(r) if isinstance(r, list) else r for r in rows), key=lambda g: (g["season"], g["week"]))
        self.snaps = snaps          # (season, week, team, key) -> offense snap share
        self.by_pid = defaultdict(list)
        self.by_name = {}
        self.team_wk = defaultdict(lambda: defaultdict(float))
        self.opp_wk = defaultdict(lambda: defaultdict(float))
        for g in rows:
            self.by_pid[g["pid"]].append(g)
            self.by_name[(g["season"], g["team"], g["key"])] = g["pid"]
            t = self.team_wk[(g["season"], g["week"], g["team"])]
            o = self.opp_wk[(g["season"], g["week"], g["opp"])]
            for k in ("attempts", "carries", "targets", "passing_yards", "rushing_yards", "receiving_yards", "passing_epa",
                      "rushing_epa", "receptions", "passing_tds", "sacks_suffered"):
                t[k] += g[k]
                o[k] += g[k]
        self._lg = {}

    def pid_of(self, season, team, key):
        return self.by_name.get((season, team, key)) or self.by_name.get((season - 1, team, key))

    def played(self, pid, season, week):
        return next((r for r in self.by_pid.get(pid, []) if (r["season"], r["week"]) == (season, week)), None)

    def hist(self, pid, season, week):
        return [g for g in self.by_pid.get(pid, []) if (g["season"], g["week"]) < (season, week)]

    def team_hist(self, team, season, week, n=4):
        ks = sorted((s, w) for (s, w, t) in self.team_wk if t == team and (s, w) < (season, week))[-n:]
        return [self.team_wk[(s, w, team)] for s, w in ks]

    def opp_hist(self, team, season, week, n=6):
        ks = sorted((s, w) for (s, w, t) in self.opp_wk if t == team and s == season and w < week)[-n:]
        return [self.opp_wk[(s, w, team)] for s, w in ks]

    def lg(self, season, week, k):
        key = (season, week, k)
        if key not in self._lg:
            vals = [d[k] for (s, w, t), d in self.opp_wk.items() if s == season and w < week]
            self._lg[key] = (sum(vals) / len(vals)) if vals else 0.0
        return self._lg[key]

    def features(self, pid, season, week, team, opp, stat, line, imp, spread, home):
        """~45 numbers known before kickoff; None for a player with under 2 games of history."""
        h = self.hist(pid, season, week)
        cur = [g for g in h if g["season"] == season]
        l3, l5, l8 = h[-3:], h[-5:], h[-8:]
        if len(h) < 2:
            return None
        mean = lambda xs: sum(xs) / len(xs) if xs else 0.0
        v = lambda gs, k: mean([g[k] for g in gs])
        ratio = lambda gs, a, b: sum(g[a] for g in gs) / max(1.0, sum(g[b] for g in gs))
        sd8 = (sum((g[stat] - v(l8, stat)) ** 2 for g in l8) / max(1, len(l8) - 1)) ** 0.5 if len(l8) > 1 else 0.0
        th = self.team_hist(team, season, week)
        oh = self.opp_hist(opp, season, week)
        lg = lambda k: self.lg(season, week, k)
        tw = self.team_wk
        f = {
            "l3": v(l3, stat), "l5": v(l5, stat), "season": v(cur, stat) if cur else v(l8, stat),
            "line_vs_l5": line - v(l5, stat), "line_vs_season": line - (v(cur, stat) if cur else v(l8, stat)),
            "line_z": (line - v(l8, stat)) / sd8 if sd8 > 0 else 0.0,
            "trend": v(l3, stat) - v(l8, stat), "sd8": sd8, "cv8": sd8 / v(l8, stat) if v(l8, stat) else 0.0,
            "tgt_share": v(l5, "target_share"), "air_share": v(l5, "air_yards_share"), "wopr": v(l5, "wopr"),
            "tgt_l3": v(l3, "targets"), "tgt_trend": v(l3, "targets") - v(l8, "targets"),
            "adot": ratio(l8, "receiving_air_yards", "targets"),
            "yac_rec": ratio(l8, "receiving_yards_after_catch", "receptions"),
            "catch_rate": ratio(l8, "receptions", "targets"),
            "ypt": ratio(l8, "receiving_yards", "targets"),
            "rec_epa_t": ratio(l8, "receiving_epa", "targets"),
            "racr": v(l5, "racr"),
            "carries_l3": v(l3, "carries"), "ypc": ratio(l8, "rushing_yards", "carries"),
            "rush_epa_c": ratio(l8, "rushing_epa", "carries"),
            "carry_share": mean([g["carries"] / max(1.0, tw[(g["season"], g["week"], g["team"])]["carries"]) for g in l5]),
            "att_l3": v(l3, "attempts"),
            "pass_epa_db": sum(g["passing_epa"] for g in l8) / max(1.0, sum(g["attempts"] + g["sacks_suffered"] for g in l8)),
            "cpoe": v(l8, "passing_cpoe"), "pass_adot": ratio(l8, "passing_air_yards", "attempts"),
            "team_pass_rate": mean([t["attempts"] / max(1.0, t["attempts"] + t["carries"]) for t in th]) if th else 0.0,
            "team_plays": mean([t["attempts"] + t["carries"] for t in th]) if th else 0.0,
            "implied": imp, "spread": spread, "home": 1.0 if home else 0.0, "week": float(week),
            "opp_pass_yds": (mean([o["passing_yards"] for o in oh]) / lg("passing_yards")) if oh and lg("passing_yards") else 1.0,
            "opp_rush_yds": (mean([o["rushing_yards"] for o in oh]) / lg("rushing_yards")) if oh and lg("rushing_yards") else 1.0,
            "opp_rec": (mean([o["receptions"] for o in oh]) / lg("receptions")) if oh and lg("receptions") else 1.0,
            "opp_pass_epa": mean([o["passing_epa"] / max(1.0, o["attempts"]) for o in oh]) if oh else 0.0,
            "opp_rush_epa": mean([o["rushing_epa"] / max(1.0, o["carries"]) for o in oh]) if oh else 0.0,
            "opp_sacks": mean([o["sacks_suffered"] for o in oh]) if oh else 0.0,
            "games_played": float(len(cur)),
        }
        sn = [self.snaps.get((g["season"], g["week"], g["team"], g["key"])) for g in l5]
        sn = [x for x in sn if x is not None]
        f["snap_avg"] = mean(sn)
        f["snap_last"] = sn[-1] if sn else 0.0
        f["snap_trend"] = (sn[-1] - mean(sn)) if sn else 0.0
        last = h[-1]
        f["weeks_since"] = float((season - last["season"]) * 20 + (week - last["week"]))
        return f


def snaps_of(verse):
    """data/nfl/nflverse.json -> {(season, week, team, key): snap share}."""
    out = {}
    for yr, xv in ((verse or {}).get("seasons") or {}).items():
        for s_, w_, t_, n_, pct in xv.get("snaps") or []:
            out[(s_, w_, t_, n_)] = pct
    return out


def index_of(verse):
    rows = [r for yr, xv in ((verse or {}).get("seasons") or {}).items() for r in xv.get("wk") or []]
    return Index(rows, snaps_of(verse)) if rows else None
