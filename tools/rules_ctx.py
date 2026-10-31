"""
rules_ctx.py - the game context behind the rules lab's splits (dev only).

For any game: is the bet side home, day or night (local start at the home park), the
home team's time zone, how many zones the away team crossed, each team's rest, and the
month. Teams come in as ESPN / NHL / nflverse abbreviations or full names from any feed.
"""
import re
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

E, C, M, P = 0, 1, 2, 3
IANA = {E: "America/New_York", C: "America/Chicago", M: "America/Denver", P: "America/Los_Angeles"}
ARIZONA = "America/Phoenix"
# (abbreviations, nickname words, zone, arizona?)
T = {
 "nba": [("ATL", "hawks", E), ("BOS", "celtics", E), ("BKN BRK", "nets", E), ("CHA CHO", "hornets", E), ("CHI", "bulls", C),
         ("CLE", "cavaliers", E), ("DAL", "mavericks", C), ("DEN", "nuggets", M), ("DET", "pistons", E), ("GS GSW", "warriors", P),
         ("HOU", "rockets", C), ("IND", "pacers", E), ("LAC", "clippers", P), ("LAL", "lakers", P), ("MEM", "grizzlies", C),
         ("MIA", "heat", E), ("MIL", "bucks", C), ("MIN", "timberwolves", C), ("NO NOP", "pelicans", C), ("NY NYK", "knicks", E),
         ("OKC", "thunder", C), ("ORL", "magic", E), ("PHI", "76ers sixers", E), ("PHX PHO", "suns", "AZ"), ("POR", "blazers", P),
         ("SAC", "kings", P), ("SA SAS", "spurs", C), ("TOR", "raptors", E), ("UTAH UTA", "jazz", M), ("WSH WAS", "wizards", E)],
 "nfl": [("ARI", "cardinals", "AZ"), ("ATL", "falcons", E), ("BAL", "ravens", E), ("BUF", "bills", E), ("CAR", "panthers", E),
         ("CHI", "bears", C), ("CIN", "bengals", E), ("CLE", "browns", E), ("DAL", "cowboys", C), ("DEN", "broncos", M),
         ("DET", "lions", E), ("GB", "packers", C), ("HOU", "texans", C), ("IND", "colts", E), ("JAX", "jaguars", E),
         ("KC", "chiefs", C), ("LV", "raiders", P), ("LAC", "chargers", P), ("LAR LA", "rams", P), ("MIA", "dolphins", E),
         ("MIN", "vikings", C), ("NE", "patriots", E), ("NO", "saints", C), ("NYG", "giants", E), ("NYJ", "jets", E),
         ("PHI", "eagles", E), ("PIT", "steelers", E), ("SF", "49ers niners", P), ("SEA", "seahawks", P), ("TB", "buccaneers", E),
         ("TEN", "titans", C), ("WSH WAS", "commanders", E)],
 "nhl": [("ANA", "ducks", P), ("UTAH UTA", "mammoth utah", M), ("BOS", "bruins", E), ("BUF", "sabres", E), ("CGY", "flames", M),
         ("CAR", "hurricanes", E), ("CHI", "blackhawks", C), ("COL", "avalanche", M), ("CBJ", "blue jackets", E), ("DAL", "stars", C),
         ("DET", "red wings", E), ("EDM", "oilers", M), ("FLA", "panthers", E), ("LA LAK", "kings", P), ("MIN", "wild", C),
         ("MTL", "canadiens", E), ("NSH", "predators", C), ("NJ NJD", "devils", E), ("NYI", "islanders", E), ("NYR", "rangers", E),
         ("OTT", "senators", E), ("PHI", "flyers", E), ("PIT", "penguins", E), ("SJ SJS", "sharks", P), ("SEA", "kraken", P),
         ("STL", "blues", C), ("TB TBL", "lightning", E), ("TOR", "maple leafs", E), ("VAN", "canucks", P), ("VGK", "golden knights", P),
         ("WSH WAS", "capitals", E), ("WPG", "jets", C)],
 "mlb": [("ARI AZ", "diamondbacks", "AZ"), ("ATL", "braves", E), ("BAL", "orioles", E), ("BOS", "red sox", E), ("CHC", "cubs", C),
         ("CWS CHW", "white sox", C), ("CIN", "reds", E), ("CLE", "guardians", E), ("COL", "rockies", M), ("DET", "tigers", E),
         ("HOU", "astros", C), ("KC", "royals", C), ("LAA", "angels", P), ("LAD", "dodgers", P), ("MIA", "marlins", E),
         ("MIL", "brewers", C), ("MIN", "twins", C), ("NYM", "mets", E), ("NYY", "yankees", E), ("ATH OAK", "athletics", P),
         ("PHI", "phillies", E), ("PIT", "pirates", E), ("SD", "padres", P), ("SF", "giants", P), ("SEA", "mariners", P),
         ("STL", "cardinals", C), ("TB", "rays", E), ("TEX", "rangers", C), ("TOR", "blue jays", E), ("WSH WAS", "nationals", E)],
}
_AB, _NICK = {}, {}
for sp, rows in T.items():
    for abbs, nicks, z in rows:
        key = abbs.split()[0]
        for a in abbs.split():
            _AB[(sp, a)] = (key, z)
        for n in [nicks] + nicks.split():
            if len(n) > 3 or n == "jazz" or n == "heat" or n == "wild" or n == "suns" or n == "nets" or n == "jets" or n == "reds" or n == "rays":
                _NICK.setdefault(sp, []).append((n, key, z))
for sp in _NICK:
    _NICK[sp].sort(key=lambda t: -len(t[0]))


# college: each school's home state (tools/cfb_states.json, from ESPN's scoreboards, non-neutral
# home games, 2025-26) to a time zone; split states go by where most of the state is
_STZ = {**{k: E for k in "CT DE DC FL GA IN ME MD MA MI NH NJ NY NC OH PA RI SC VT VA WV KY".split()},
        **{k: C for k in "AL AR IL IA KS LA MN MS MO NE ND OK SD TN TX WI".split()},
        **{k: M for k in "CO ID MT NM UT WY".split()}, "AZ": "AZ", **{k: P for k in "CA NV OR WA HI AK".split()}}
try:
    import json as _j, os as _o
    _CFB = {k: _STZ.get(v) for k, v in _j.load(open(_o.path.join(_o.path.dirname(__file__), "cfb_states.json"))).items()}
except Exception:
    _CFB = {}


def team(sp, t):
    """(canonical key, zone) for a team from any feed, or (raw, None)."""
    if not t:
        return None, None
    s = str(t).strip()
    if sp == "cfb":
        return s, _CFB.get(s.upper())
    if (sp, s.upper()) in _AB:
        return _AB[(sp, s.upper())]
    low = " " + re.sub(r"[^a-z0-9 ]", " ", s.lower()) + " "
    for n, key, z in _NICK.get(sp, []):
        if " " + n + " " in low:
            return key, z
    return s, None


def zone_index(z):
    return {E: 0, C: 1, M: 2, P: 3, "AZ": 2}.get(z)


def local_hour(sp, start_iso, z):
    try:
        dt = datetime.fromisoformat(str(start_iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    tz = ARIZONA if z == "AZ" else IANA.get(z) if z is not None else "America/New_York"
    return dt.astimezone(ZoneInfo(tz)).hour


class Schedule:
    """Every game a team played, for rest days."""
    def __init__(self):
        self.d = {}

    def add(self, sp, home, away, day):
        for t in (home, away):
            k, _ = team(sp, t)
            if k:
                self.d.setdefault((sp, k), set()).add(day)

    def rest(self, sp, t, day):
        k, _ = team(sp, t)
        ds = sorted(x for x in self.d.get((sp, k), ()) if x < day)
        if not ds:
            return None
        n = (date.fromisoformat(day) - date.fromisoformat(ds[-1])).days
        return n if n <= 10 else None      # a season break, not rest


def ctx(sp, home, away, start_iso, day, a_home, S):
    """[side A home (1 / 0 / None), night (1) or day (0), home zone 0-3, zones the away team
    crossed, home rest, away rest, month]."""
    hk, hz = team(sp, home)
    ak, az = team(sp, away)
    hr = local_hour(sp, start_iso, hz)
    zi, za = zone_index(hz), zone_index(az)
    return [a_home, None if hr is None else int(hr >= 17), zi, None if zi is None or za is None else abs(zi - za),
            S.rest(sp, home, day) if S else None, S.rest(sp, away, day) if S else None, int(day[5:7])]
