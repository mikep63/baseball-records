#!/usr/bin/env python3
"""Baseball Records web app over the Lahman database (1871-2025).

Standard library only. Usage:  python3 app.py [port]   (default 8000)
"""
import json
import os
import sqlite3
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import franchises

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "lahman.sqlite")
STATIC = os.path.join(BASE, "static")

# ---------------------------------------------------------------- stat catalog
# expr operates on per-season columns; agg_expr on SUM()ed columns.
BATTING_SUMS = ["G", "AB", "R", "H", "2B", "3B", "HR", "RBI", "SB", "CS",
                "BB", "SO", "IBB", "HBP", "SH", "SF", "GIDP"]
PITCHING_SUMS = ["W", "L", "G", "GS", "CG", "SHO", "SV", "IPouts", "H", "ER",
                 "HR", "BB", "SO", "WP", "HBP", "BFP", "GF", "R"]

# name -> (label, kind) kind: count = plain summed column, rate = derived
BATTING_STATS = {
    "G":    "Games", "AB": "At Bats", "R": "Runs", "H": "Hits",
    "2B":   "Doubles", "3B": "Triples", "HR": "Home Runs", "RBI": "RBI",
    "SB":   "Stolen Bases", "BB": "Walks", "SO": "Strikeouts",
    "TB":   "Total Bases", "AVG": "Batting Average", "OBP": "On-Base %",
    "SLG":  "Slugging %", "OPS": "OPS",
}
PITCHING_STATS = {
    "W": "Wins", "L": "Losses", "G": "Games", "GS": "Starts",
    "CG": "Complete Games", "SHO": "Shutouts", "SV": "Saves",
    "IP": "Innings Pitched", "SO": "Strikeouts", "BB": "Walks",
    "ERA": "ERA", "WHIP": "WHIP",
}
RATE_BATTING = {"AVG", "OBP", "SLG", "OPS"}
RATE_PITCHING = {"ERA", "WHIP"}
ASCENDING = {"ERA", "WHIP"}  # lower is better

# Leaderboards rank every league in the database, with no whitelist: all 19 of
# them are major-league caliber by SABR's own reckoning (readme2025.txt §1.1).
# That includes the barnstorming clubs filed under IND, EAS, WES, NAC and INT —
# the Cuban X Giants, Philadelphia Giants, Brooklyn Royal Giants and their
# peers — which SABR states were "selected as major league caliber in light of
# the economic and social conditions that forced them to play outside a typical
# league structure". Segregation is why they have no league to be listed under;
# filtering them out would drop 876 players for the shape of their records
# rather than the substance.
#
# Sample size is a separate question, and MIN_SCHEDULE is what answers it.
# A league season too short to establish a rate title sets no rate title: some
# of these clubs have a single recorded game, where 3.1 PA per game is a bar of
# three plate appearances and a 1-for-1 afternoon takes the batting crown. This
# floors that bar, and catches stub seasons in the established leagues too —
# the ECL folded seven games into 1928.
MIN_SCHEDULE = 40

# Schedule length, for the qualifier and the dashboard, measured in games that
# were decided rather than games played. Teams.G counts ties, which were
# replayed rather than settled before lights and are not part of anyone's
# schedule: the 1989 Pirates and Cardinals show G=164 against a 162-game
# season, and the 1904 Athletics G=162 against 154. Taking G would hold those
# leagues to a bar six to eight games too high, which is enough to move a
# batting title — Billy Goodman in 1950 and Rod Carew in 1969 both lose theirs.
DECIDED = "COALESCE(t.W,0) + COALESCE(t.L,0)"


# The column that must actually have been recorded for a stat to mean anything
# in a given league-season. Stolen bases went unrecorded in 22 league-seasons
# and batter strikeouts in 53; COALESCE then reads every player as zero and
# they all tie, which is how the 1884 Union Association listed 276 stolen-base
# "leaders". Rate stats point at their numerator, since a missing denominator
# already yields NULL and drops out on its own.
BATTING_SOURCE = {
    "G": "G", "AB": "AB", "R": "R", "H": "H", "2B": "2B", "3B": "3B",
    "HR": "HR", "RBI": "RBI", "SB": "SB", "BB": "BB", "SO": "SO",
    "TB": "H", "AVG": "H", "OBP": "H", "SLG": "H", "OPS": "H",
}
PITCHING_SOURCE = {
    "W": "W", "L": "L", "G": "G", "GS": "GS", "CG": "CG", "SHO": "SHO",
    "SV": "SV", "SO": "SO", "BB": "BB", "IP": "IPouts", "ERA": "ER",
    "WHIP": "H",
}


def full_name(p):
    """Display name. 413 players, all from the Negro League records, have no
    first name: plain concatenation makes them NULL in SQL and " Acea" in the
    browser, where both should read "Acea"."""
    return ("TRIM(COALESCE({p}.nameFirst,'') || ' ' || "
            "COALESCE({p}.nameLast,''))").format(p=p)


def has_lg(p):
    """Rows with a league. A blank one would group into a nameless "" league."""
    return "{p}.lgID IS NOT NULL AND {p}.lgID <> ''".format(p=p)

def batting_expr(stat, p="b"):
    """SQL expression for a batting stat over (already aggregated) columns."""
    c = lambda col: 'CAST(%s."%s" AS REAL)' % (p, col)
    n = lambda col: 'COALESCE(%s."%s",0)' % (p, col)
    TB = '(%s + %s + 2*%s + 3*%s)' % (n("H"), n("2B"), n("3B"), n("HR"))
    AB = n("AB")
    OBP_NUM = '(%s + %s + %s)' % (n("H"), n("BB"), n("HBP"))
    OBP_DEN = '(%s + %s + %s + %s)' % (n("AB"), n("BB"), n("HBP"), n("SF"))
    if stat == "TB":
        return TB
    if stat == "AVG":
        return 'CASE WHEN %s > 0 THEN %s*1.0/%s END' % (AB, n("H"), AB)
    if stat == "SLG":
        return 'CASE WHEN %s > 0 THEN %s*1.0/%s END' % (AB, TB, AB)
    if stat == "OBP":
        return 'CASE WHEN %s > 0 THEN %s*1.0/%s END' % (OBP_DEN, OBP_NUM, OBP_DEN)
    if stat == "OPS":
        return ('(CASE WHEN %s > 0 THEN %s*1.0/%s ELSE 0 END + '
                'CASE WHEN %s > 0 THEN %s*1.0/%s ELSE 0 END)'
                % (OBP_DEN, OBP_NUM, OBP_DEN, AB, TB, AB))
    if stat in BATTING_SUMS:
        return n(stat)
    raise ValueError(stat)

def pitching_expr(stat, p="p"):
    n = lambda col: 'COALESCE(%s."%s",0)' % (p, col)
    IP = '(%s/3.0)' % n("IPouts")
    if stat == "IP":
        return IP
    if stat == "ERA":
        return 'CASE WHEN %s > 0 THEN 9.0*%s/%s END' % (n("IPouts"), n("ER"), IP)
    if stat == "WHIP":
        return 'CASE WHEN %s > 0 THEN (%s+%s)*1.0/%s END' % (n("IPouts"), n("BB"), n("H"), IP)
    if stat in PITCHING_SUMS:
        return n(stat)
    raise ValueError(stat)

PA_EXPR = ('(COALESCE(b."AB",0)+COALESCE(b."BB",0)+COALESCE(b."HBP",0)'
           '+COALESCE(b."SH",0)+COALESCE(b."SF",0))')


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def rows_to_dicts(rows):
    return [dict(r) for r in rows]


# ---------------------------------------------------------------- api handlers
def api_meta(q, conn):
    yr = conn.execute('SELECT MIN(yearID) lo, MAX(yearID) hi FROM Teams').fetchone()
    return {
        "minYear": yr["lo"], "maxYear": yr["hi"],
        "battingStats": BATTING_STATS, "pitchingStats": PITCHING_STATS,
        "rateStats": sorted(RATE_BATTING | RATE_PITCHING),
    }


def api_search(q, conn):
    """Name search, ranked by match quality, then fame, then playing time.

    Career games alone ranks badly. It buries pitchers, who play a fraction of
    the games a position player does — searching "young" put Cy Young fourth,
    behind three journeyman infielders — and it buries Negro League players,
    whose seasons were 60 to 90 games rather than 154, which cost Josh Gibson
    to a pair of Gibsons nobody remembers. Hall of Fame membership corrects
    both, because it does not care how the games were accumulated.

    Match quality comes first regardless: a term buried mid-word ("ruth" in
    Caruthers) should not outrank the players actually named for it.
    """
    term = (q.get("q", [""])[0]).strip()
    if len(term) < 2:
        return {"players": []}
    like = "%" + term.replace(" ", "%") + "%"
    low = term.lower()
    sql = '''
      SELECT p.playerID, p.nameFirst, p.nameLast, p.birthYear,
             p.debut, p.finalGame,
             (SELECT COALESCE(SUM(G_all),0) FROM Appearances a
               WHERE a.playerID = p.playerID) AS careerG,
             CASE WHEN EXISTS(SELECT 1 FROM HallOfFame h
                    WHERE h.playerID = p.playerID AND h.inducted = 'Y')
                  THEN 0 ELSE 1 END AS notHof,
             CASE
               WHEN LOWER(TRIM(COALESCE(p.nameFirst,'') || ' ' ||
                               COALESCE(p.nameLast,''))) = ?
                 OR LOWER(COALESCE(p.nameLast,'')) = ? THEN 0
               WHEN LOWER(COALESCE(p.nameLast,'')) LIKE ? THEN 1
               WHEN LOWER(COALESCE(p.nameFirst,'')) LIKE ?
                 OR LOWER(TRIM(COALESCE(p.nameFirst,'') || ' ' ||
                               COALESCE(p.nameLast,''))) LIKE ? THEN 2
               ELSE 3
             END AS tier
      FROM People p
      WHERE (p.nameFirst || ' ' || p.nameLast) LIKE ? COLLATE NOCASE
         OR p.nameLast LIKE ? COLLATE NOCASE
      ORDER BY tier, notHof, careerG DESC
      LIMIT 25'''
    args = (low, low, low + "%", low + "%", low + "%", like, like)
    out = []
    for r in conn.execute(sql, args):
        out.append({
            "playerID": r["playerID"],
            "name": ("%s %s" % (r["nameFirst"] or "", r["nameLast"] or "")).strip(),
            "birthYear": r["birthYear"],
            "debut": (r["debut"] or "")[:4],
            "finalGame": (r["finalGame"] or "")[:4],
            "careerG": r["careerG"],
        })
    return {"players": out}


def _career_batting(conn, pid):
    seasons = rows_to_dicts(conn.execute('''
      SELECT b.yearID, b.stint, b.teamID, b.lgID, b.G, b.AB, b.R, b.H,
             b."2B" AS D2, b."3B" AS D3, b.HR, b.RBI, b.SB, b.BB, b.SO,
             b.HBP, b.SF,
             %s AS TB, %s AS AVG, %s AS OBP, %s AS SLG, %s AS OPS
      FROM Batting b WHERE b.playerID = ?
      ORDER BY b.yearID, b.stint''' % (
        batting_expr("TB"), batting_expr("AVG"), batting_expr("OBP"),
        batting_expr("SLG"), batting_expr("OPS")), (pid,)))
    total = conn.execute('''
      SELECT COUNT(DISTINCT b.yearID) AS years, SUM(b.G) G, SUM(b.AB) AB,
             SUM(b.R) R, SUM(b.H) H, SUM(b."2B") D2, SUM(b."3B") D3,
             SUM(b.HR) HR, SUM(b.RBI) RBI, SUM(b.SB) SB, SUM(b.BB) BB,
             SUM(b.SO) SO, SUM(b.HBP) HBP, SUM(b.SF) SF
      FROM Batting b WHERE b.playerID = ?''', (pid,)).fetchone()
    totals = dict(total) if total and total["G"] else None
    if totals:
        ab = totals["AB"] or 0
        h = totals["H"] or 0
        tb = h + (totals["D2"] or 0) + 2 * (totals["D3"] or 0) + 3 * (totals["HR"] or 0)
        obp_den = ab + (totals["BB"] or 0) + (totals["HBP"] or 0) + (totals["SF"] or 0)
        obp_num = h + (totals["BB"] or 0) + (totals["HBP"] or 0)
        totals["TB"] = tb
        totals["AVG"] = h / ab if ab else None
        totals["SLG"] = tb / ab if ab else None
        totals["OBP"] = obp_num / obp_den if obp_den else None
        if ab:
            totals["OPS"] = (totals["OBP"] or 0) + (totals["SLG"] or 0)
    return seasons, totals


def _career_pitching(conn, pid):
    seasons = rows_to_dicts(conn.execute('''
      SELECT p.yearID, p.stint, p.teamID, p.lgID, p.W, p.L, p.G, p.GS,
             p.CG, p.SHO, p.SV, ROUND(p.IPouts/3.0, 1) AS IP, p.H, p.ER,
             p.HR, p.BB, p.SO, %s AS ERA, %s AS WHIP
      FROM Pitching p WHERE p.playerID = ?
      ORDER BY p.yearID, p.stint''' % (
        pitching_expr("ERA"), pitching_expr("WHIP")), (pid,)))
    total = conn.execute('''
      SELECT COUNT(DISTINCT yearID) years, SUM(W) W, SUM(L) L, SUM(G) G,
             SUM(GS) GS, SUM(CG) CG, SUM(SHO) SHO, SUM(SV) SV,
             SUM(IPouts) IPouts, SUM(H) H, SUM(ER) ER, SUM(HR) HR,
             SUM(BB) BB, SUM(SO) SO
      FROM Pitching WHERE playerID = ?''', (pid,)).fetchone()
    totals = dict(total) if total and total["G"] else None
    if totals:
        ipo = totals["IPouts"] or 0
        totals["IP"] = round(ipo / 3.0, 1)
        totals["ERA"] = 9.0 * (totals["ER"] or 0) / (ipo / 3.0) if ipo else None
        totals["WHIP"] = ((totals["BB"] or 0) + (totals["H"] or 0)) / (ipo / 3.0) if ipo else None
    return seasons, totals


def _position_runs(conn, pid):
    """Primary position per season, collapsed into contiguous runs.

    The career-by-position table says where a player spent his time; this says
    when, which is the part the totals destroy — Yount reads SS 1974-1984 then
    OF 1985-1993 rather than two undated piles of games.

    Only the position he played most that season counts, so a shortstop's one
    inning in the outfield does not break the run. Neither does a season missed
    entirely: Musial went to war in 1945, which is not a position change.
    """
    rows = conn.execute('''
      SELECT yearID, POS FROM (
        SELECT yearID, POS,
               ROW_NUMBER() OVER (PARTITION BY yearID ORDER BY G DESC, POS) rn
        FROM Fielding WHERE playerID = ?)
      WHERE rn = 1 ORDER BY yearID''', (pid,)).fetchall()
    out = []
    for r in rows:
        if out and out[-1]["POS"] == r["POS"]:
            out[-1]["lastYear"] = r["yearID"]
        else:
            out.append({"POS": r["POS"], "firstYear": r["yearID"],
                        "lastYear": r["yearID"]})
    return out


def api_player(pid, conn):
    p = conn.execute('SELECT * FROM People WHERE playerID = ?', (pid,)).fetchone()
    if not p:
        return {"error": "player not found"}
    bio = dict(p)
    batting, batting_tot = _career_batting(conn, pid)
    pitching, pitching_tot = _career_pitching(conn, pid)
    fielding = rows_to_dicts(conn.execute('''
      SELECT POS, COUNT(DISTINCT yearID) years, SUM(G) G, SUM(PO) PO,
             SUM(A) A, SUM(E) E, SUM(DP) DP
      FROM Fielding WHERE playerID = ? GROUP BY POS ORDER BY G DESC''', (pid,)))
    awards = rows_to_dicts(conn.execute('''
      SELECT awardID, yearID, lgID, notes FROM AwardsPlayers
      WHERE playerID = ? ORDER BY yearID''', (pid,)))
    # one row per game: 1959-1962 had two All-Star games a year
    allstar = [r["yearID"] for r in conn.execute(
        'SELECT yearID FROM AllstarFull WHERE playerID = ? ORDER BY yearID', (pid,))]
    hof = conn.execute('''
      SELECT yearid, votedBy, category FROM HallOfFame
      WHERE playerID = ? AND inducted = 'Y' ''', (pid,)).fetchone()
    post_b = conn.execute('''
      SELECT SUM(G) G, SUM(AB) AB, SUM(H) H, SUM(HR) HR, SUM(RBI) RBI
      FROM BattingPost WHERE playerID = ?''', (pid,)).fetchone()
    return {
        "bio": bio,
        "batting": batting, "battingTotals": batting_tot,
        "pitching": pitching, "pitchingTotals": pitching_tot,
        "fielding": fielding, "positions": _position_runs(conn, pid),
        "awards": awards, "allstar": allstar,
        "hof": dict(hof) if hof else None,
        "postBatting": dict(post_b) if post_b and post_b["G"] else None,
    }


def api_teams(q, conn):
    year = int(q.get("year", ["0"])[0])
    teams = rows_to_dicts(conn.execute('''
      SELECT yearID, lgID, divID, teamID, name, Rank, G, W, L, R, RA,
             attendance, park,
             CASE WHEN WSWin='Y' THEN 1 ELSE 0 END AS wonWS,
             CASE WHEN LgWin='Y' THEN 1 ELSE 0 END AS wonLg
      FROM Teams WHERE yearID = ?
      ORDER BY lgID, divID, Rank, W DESC''', (year,)))
    return {"teams": teams}


def api_postseason(q, conn):
    year = int(q.get("year", ["0"])[0])
    series = rows_to_dicts(conn.execute('''
      SELECT s.round, s.teamIDwinner, s.lgIDwinner, s.teamIDloser,
             s.lgIDloser, s.wins, s.losses, s.ties,
             (SELECT t.name FROM Teams t
               WHERE t.yearID = s.yearID AND t.teamID = s.teamIDwinner) AS winnerName,
             (SELECT t.name FROM Teams t
               WHERE t.yearID = s.yearID AND t.teamID = s.teamIDloser) AS loserName
      FROM SeriesPost s WHERE s.yearID = ?''', (year,)))
    return {"series": series, "year": year}


def api_roster(q, conn):
    year = int(q.get("year", ["0"])[0])
    team = q.get("team", [""])[0]
    batters = rows_to_dicts(conn.execute('''
      SELECT b.playerID, TRIM(COALESCE(pe.nameFirst,'') || ' ' || COALESCE(pe.nameLast,'')) AS name,
             (SELECT f.POS FROM Fielding f
               WHERE f.playerID = b.playerID AND f.yearID = b.yearID
                 AND f.teamID = b.teamID
               ORDER BY f.G DESC LIMIT 1) AS POS,
             SUM(b.G) G, SUM(b.AB) AB, SUM(b.R) R, SUM(b.H) H,
             SUM(b."2B") D2, SUM(b."3B") D3, SUM(b.HR) HR, SUM(b.RBI) RBI,
             SUM(b.SB) SB, SUM(b.BB) BB,
             CASE WHEN SUM(b.AB) > 0
                  THEN SUM(b.H)*1.0/SUM(b.AB) END AS AVG
      FROM Batting b JOIN People pe ON pe.playerID = b.playerID
      WHERE b.yearID = ? AND b.teamID = ?
      GROUP BY b.playerID
      ORDER BY SUM(b.AB) DESC, SUM(b.G) DESC''', (year, team)))
    pitchers = rows_to_dicts(conn.execute('''
      SELECT p.playerID, TRIM(COALESCE(pe.nameFirst,'') || ' ' || COALESCE(pe.nameLast,'')) AS name,
             SUM(p.W) W, SUM(p.L) L, SUM(p.G) G, SUM(p.GS) GS,
             SUM(p.SV) SV, ROUND(SUM(p.IPouts)/3.0, 1) AS IP,
             SUM(p.SO) SO, SUM(p.BB) BB,
             CASE WHEN SUM(p.IPouts) > 0
                  THEN 9.0*SUM(p.ER)/(SUM(p.IPouts)/3.0) END AS ERA
      FROM Pitching p JOIN People pe ON pe.playerID = p.playerID
      WHERE p.yearID = ? AND p.teamID = ?
      GROUP BY p.playerID
      ORDER BY SUM(p.IPouts) DESC''', (year, team)))
    trow = conn.execute('SELECT name, W, L, Rank, lgID, divID FROM Teams WHERE yearID=? AND teamID=?',
                        (year, team)).fetchone()
    return {"team": dict(trow) if trow else None,
            "batters": batters, "pitchers": pitchers}


# The two Triple Crowns, which is what a season is remembered by. Deliberately
# not the full stat catalogue — the Leaders tab is there for that, and this
# panel earns its place by being glanceable.
DASHBOARD_STATS = [("batting", "AVG"), ("batting", "HR"), ("batting", "RBI"),
                ("pitching", "W"), ("pitching", "ERA"), ("pitching", "SO")]


def _dashboard_top(rows, value_of, qualifies, ascending=False):
    """Leader(s) of one stat in one league, keeping ties together."""
    best, winners = None, []
    for r in rows:
        if not qualifies(r):
            continue
        v = value_of(r)
        if v is None:
            continue
        v = round(v, 9)
        if best is None or (v < best if ascending else v > best):
            best, winners = v, [r]
        elif v == best:
            winners.append(r)
    return best, winners


def api_season_leaders(q, conn):
    """Every league's leaders for one season, for the Seasons tab panel."""
    year = int(q.get("year", ["0"])[0])
    games = {r["lgID"]: r["g"] for r in conn.execute(
        'SELECT lgID, MAX(%s) g FROM Teams t WHERE t.yearID = ? AND %s '
        'GROUP BY lgID' % (DECIDED, has_lg("t")), (year,))}
    if not games:
        return {"year": year, "leagues": []}

    bat = rows_to_dicts(conn.execute('''
      SELECT b.lgID, b.playerID, TRIM(COALESCE(pe.nameFirst,'') || ' ' || COALESCE(pe.nameLast,'')) AS name,
             MIN(b.teamID) AS teamID, SUM(b.H) H, SUM(b.AB) AB,
             SUM(b.HR) HR, SUM(b.RBI) RBI,
             SUM(COALESCE(b.AB,0)+COALESCE(b.BB,0)+COALESCE(b.HBP,0)
                 +COALESCE(b.SH,0)+COALESCE(b.SF,0)) AS PA
      FROM Batting b JOIN People pe ON pe.playerID = b.playerID
      WHERE b.yearID = ? AND %s
      GROUP BY b.lgID, b.playerID''' % has_lg("b"), (year,)))
    pit = rows_to_dicts(conn.execute('''
      SELECT p.lgID, p.playerID, TRIM(COALESCE(pe.nameFirst,'') || ' ' || COALESCE(pe.nameLast,'')) AS name,
             MIN(p.teamID) AS teamID, SUM(p.W) W, SUM(p.SO) SO,
             SUM(p.IPouts) AS IPouts, SUM(p.ER) ER
      FROM Pitching p JOIN People pe ON pe.playerID = p.playerID
      WHERE p.yearID = ? AND %s
      GROUP BY p.lgID, p.playerID''' % has_lg("p"), (year,)))

    by_lg = {}
    for r in bat:
        by_lg.setdefault(r["lgID"], ([], []))[0].append(r)
    for r in pit:
        by_lg.setdefault(r["lgID"], ([], []))[1].append(r)

    leagues = []
    for lg in sorted(games):
        rows_b, rows_p = by_lg.get(lg, ([], []))
        bar = max(games[lg] or 0, MIN_SCHEDULE)
        tiles = []
        for cat, stat in DASHBOARD_STATS:
            if cat == "batting":
                if stat == "AVG":
                    value_of = lambda r: (r["H"] / r["AB"]) if r["AB"] else None
                    qualifies = lambda r: (r["PA"] or 0) >= 3.1 * bar
                else:
                    value_of = lambda r, s=stat: r[s]
                    qualifies = lambda r: True
                best, who = _dashboard_top(rows_b, value_of, qualifies)
                label = BATTING_STATS[stat]
            else:
                if stat == "ERA":
                    value_of = (lambda r: 9.0 * (r["ER"] or 0) / (r["IPouts"] / 3.0)
                                if r["IPouts"] else None)
                    qualifies = lambda r: (r["IPouts"] or 0) / 3.0 >= bar
                else:
                    value_of = lambda r, s=stat: r[s]
                    qualifies = lambda r: True
                best, who = _dashboard_top(rows_p, value_of, qualifies,
                                        ascending=(stat in ASCENDING))
                label = PITCHING_STATS[stat]
            # A column the league never kept reads as zero for everyone and
            # ties the whole roster — 1903 Eastern Independent Clubs had 24
            # home run "leaders" on nothing. Say it was not recorded instead.
            src = (BATTING_SOURCE if cat == "batting" else PITCHING_SOURCE)[stat]
            pool = rows_b if cat == "batting" else rows_p
            recorded = any(r[src] is not None for r in pool)
            if not recorded or (best == 0 and stat not in ASCENDING):
                best, who, recorded = None, [], False
            tiles.append({
                "cat": cat, "stat": stat, "label": label, "value": best,
                "recorded": recorded,
                "leaders": [{"playerID": r["playerID"], "name": r["name"],
                             "teamID": r["teamID"]} for r in who[:3]],
                "tied": len(who),
            })
        leagues.append({"lgID": lg, "games": games[lg], "tiles": tiles})
    return {"year": year, "leagues": leagues}


# Franchise history costs a full pass over Teams to build, and the database
# is read-only while the server runs, so build it once.
_FRANCHISES = None


def _franchises(conn):
    global _FRANCHISES
    if _FRANCHISES is None:
        _FRANCHISES = franchises.build(
            rows_to_dicts(conn.execute(
                'SELECT franchID, yearID, teamID, lgID, name, W, L, WSWin, '
                'LgWin FROM Teams')),
            rows_to_dicts(conn.execute(
                'SELECT franchID, franchName, active FROM TeamsFranchises')),
            rows_to_dicts(conn.execute('SELECT city FROM Parks')))
    return _FRANCHISES


def api_franchises(q, conn):
    return {"franchises": [franchises.summary(f) for f in _franchises(conn)]}


def api_franchise(fid, conn):
    f = next((x for x in _franchises(conn) if x["franchID"] == fid), None)
    if not f:
        return {"error": "franchise not found"}
    seasons = rows_to_dicts(conn.execute('''
      SELECT yearID, teamID, lgID, divID, name, Rank, G, W, L, R, RA,
             CASE WHEN WSWin='Y' THEN 1 ELSE 0 END AS wonWS,
             CASE WHEN LgWin='Y' THEN 1 ELSE 0 END AS wonLg
      FROM Teams WHERE franchID = ? ORDER BY yearID''', (fid,)))
    # who ran the club, in the order they held the job — 516 seasons had two
    # managers and one had nine, so this is a list rather than a name
    mgrs = {}
    for r in conn.execute('''
      SELECT m.yearID, m.teamID, m.plyrMgr, %s AS name
      FROM Managers m JOIN People p ON p.playerID = m.playerID
      JOIN Teams t ON t.yearID = m.yearID AND t.teamID = m.teamID
      WHERE t.franchID = ? ORDER BY m.yearID, m.inseason''' % full_name("p"),
                          (fid,)):
        mgrs.setdefault((r["yearID"], r["teamID"]), []).append(
            {"name": r["name"], "playerMgr": r["plyrMgr"] == "Y"})
    for s_ in seasons:
        s_["managers"] = mgrs.get((s_["yearID"], s_["teamID"]), [])
    return {"franchise": franchises.summary(f), "eras": f["eras"],
            "locations": f["locations"], "seasons": seasons}


def _leaders(conn, cat, stat, y0, y1, limit=10, per_season=False):
    """Leader query. per_season=True ranks individual seasons; else aggregates the span."""
    if cat == "pitching":
        if stat not in PITCHING_STATS:
            raise ValueError("bad stat")
        table, prefix = "Pitching", "p"
        expr_fn, sums = pitching_expr, PITCHING_SUMS
        is_rate = stat in RATE_PITCHING
    else:
        if stat not in BATTING_STATS:
            raise ValueError("bad stat")
        table, prefix = "Batting", "b"
        expr_fn, sums = batting_expr, BATTING_SUMS
        is_rate = stat in RATE_BATTING
    order = "ASC" if stat in ASCENDING else "DESC"

    if per_season:
        group = '%s.playerID, %s.yearID' % (prefix, prefix)
    else:
        group = '%s.playerID' % prefix
    sum_cols = ", ".join('SUM({p}."{c}") AS "{c}"'.format(p=prefix, c=c) for c in sums)

    # Games the player's own league played, for the rate-stat qualifier
    # below. A player traded across leagues mid-season has no single league,
    # so he is held to the longest schedule he appeared in — exact for the
    # overwhelming majority, conservative for the rare crossover.
    lg_games = ""
    if is_rate and per_season:
        lg_games = ''',
             MAX(COALESCE(
               (SELECT MAX(%s) FROM Teams t
                 WHERE t.yearID = {p}.yearID AND t.lgID = {p}.lgID),
               (SELECT MAX(%s) FROM Teams t
                 WHERE t.yearID = {p}.yearID))) AS lgGames'''.format(p=prefix) \
            % (DECIDED, DECIDED)

    inner = '''
      SELECT {p}.playerID AS playerID, {year_col} AS yearID,
             COUNT(DISTINCT {p}.yearID) AS nyears,
             MIN({p}.yearID) AS firstYear, MAX({p}.yearID) AS lastYear,
             COUNT(DISTINCT {p}.teamID) AS nteams,
             MIN({p}.teamID) AS teamID, {sums}{lg}
      FROM {table} {p}
      WHERE {p}.yearID BETWEEN ? AND ?
      GROUP BY {group}'''.format(
        p=prefix, year_col=('%s.yearID' % prefix) if per_season else 'NULL',
        sums=sum_cols, lg=lg_games, table=table, group=group)

    # Qualifiers for rate stats (min playing time). Single seasons follow the
    # official rule — 3.1 PA (or 1 IP) per game the player's league played.
    # Measuring against the whole year instead holds a short-schedule league
    # to a longer one's bar: in 1924 the Negro Leagues played ~80 games to the
    # AL's 157, so nobody in them could ever qualify, and in strike-shortened
    # 1994 it cost Steve Ontiveros the AL ERA title he actually won.
    #
    # MIN_SCHEDULE floors that bar. Some Lahman "leagues" are barnstorming
    # fragments of a handful of recorded games, where 3.1 per game is a bar
    # of three plate appearances and a 1-for-1 day wins the batting title.
    # The recognised Negro major leagues all played 40+, so the floor leaves
    # them on the real rule and only bites the fragments.
    qual = ""
    bar = 'MAX(x.lgGames, %d)' % MIN_SCHEDULE
    if is_rate:
        if cat == "batting":
            pa = ('(COALESCE(x."AB",0)+COALESCE(x."BB",0)+COALESCE(x."HBP",0)'
                  '+COALESCE(x."SH",0)+COALESCE(x."SF",0))')
            if per_season:
                qual = 'AND %s >= 3.1 * %s' % (pa, bar)
            else:
                # not the official rule: a span-length heuristic of our own
                min_pa = min(3000, 400 * (y1 - y0 + 1))
                qual = 'AND %s >= %d' % (pa, min_pa)
        else:
            if per_season:
                qual = 'AND COALESCE(x."IPouts",0)/3.0 >= %s' % bar
            else:
                min_ip = min(1000, 130 * (y1 - y0 + 1))
                qual = 'AND COALESCE(x."IPouts",0)/3.0 >= %d' % min_ip

    expr = expr_fn(stat, "x")
    sql = '''
      SELECT x.*, %s AS value, TRIM(COALESCE(pe.nameFirst,'') || ' ' || COALESCE(pe.nameLast,'')) AS name
      FROM (%s) x
      JOIN People pe ON pe.playerID = x.playerID
      WHERE %s IS NOT NULL %s
      ORDER BY value %s, x.playerID
      LIMIT ?''' % (expr, inner, expr, qual, order)
    rows = rows_to_dicts(conn.execute(sql, (y0, y1, limit)))
    return rows


def api_history(q, conn):
    """Each league's leader in one stat, every year, newest first.

    The other spans answer "who was best" once. This answers it repeatedly, so
    a single page carries the whole line of succession — every strikeout title
    from 2025 back to 1871, in every league that played, one row each.

    RANK() rather than ROW_NUMBER(), so a shared title stays shared.
    """
    y0 = int(q.get("start", ["0"])[0])
    y1 = int(q.get("end", ["0"])[0])
    if y1 < y0:
        y0, y1 = y1, y0
    stat = q.get("stat", ["HR"])[0]
    cat = q.get("cat", ["batting"])[0]

    if cat == "pitching":
        if stat not in PITCHING_STATS:
            raise ValueError("bad stat")
        table, prefix, sums = "Pitching", "p", PITCHING_SUMS
        expr = pitching_expr(stat, "v")
        src = PITCHING_SOURCE[stat]
        qual = ('AND COALESCE(v."IPouts",0)/3.0 >= v.bar'
                if stat in RATE_PITCHING else "")
    else:
        if stat not in BATTING_STATS:
            raise ValueError("bad stat")
        table, prefix, sums = "Batting", "b", BATTING_SUMS
        expr = batting_expr(stat, "v")
        src = BATTING_SOURCE[stat]
        qual = ('AND (COALESCE(v."AB",0)+COALESCE(v."BB",0)+COALESCE(v."HBP",0)'
                '+COALESCE(v."SH",0)+COALESCE(v."SF",0)) >= 3.1 * v.bar'
                if stat in RATE_BATTING else "")
    order = "ASC" if stat in ASCENDING else "DESC"
    # A leader of zero is not a leader: where a column was only partly kept,
    # everyone COALESCEs to nothing and ties. Only for stats where more is
    # better — a 0.00 earned run average is a real result.
    nonzero = "" if stat in ASCENDING else "AND r.value > 0"
    sum_cols = ", ".join('SUM({p}."{c}") AS "{c}"'.format(p=prefix, c=c)
                         for c in sums)

    sql = """
      WITH sched AS (
        SELECT yearID, lgID, MAX({decided}) AS g
        FROM Teams t WHERE t.yearID BETWEEN ? AND ? AND {haslg}
        GROUP BY yearID, lgID),
      have AS (
        SELECT yearID, lgID FROM {table} h
        WHERE h.yearID BETWEEN ? AND ?
        GROUP BY yearID, lgID HAVING COUNT(h."{src}") > 0),
      agg AS (
        SELECT {p}.yearID, {p}.lgID, {p}.playerID,
               MIN({p}.teamID) AS teamID, COUNT(DISTINCT {p}.teamID) AS nteams,
               {sums}
        FROM {table} {p}
        WHERE {p}.yearID BETWEEN ? AND ?
          AND {p}.lgID IS NOT NULL AND {p}.lgID <> ''
        GROUP BY {p}.yearID, {p}.lgID, {p}.playerID),
      v AS (
        SELECT agg.*, MAX(sched.g, {floor}) AS bar
        FROM agg JOIN sched
          ON sched.yearID = agg.yearID AND sched.lgID = agg.lgID),
      ranked AS (
        SELECT v.yearID, v.lgID, v.playerID, v.teamID, v.nteams,
               ROUND({expr}, 9) AS value,
               RANK() OVER (PARTITION BY v.yearID, v.lgID
                            ORDER BY ROUND({expr}, 9) {order}) AS rnk
        FROM v WHERE {expr} IS NOT NULL {qual})
      SELECT r.yearID, r.lgID, r.value, r.teamID, r.nteams,
             TRIM(COALESCE(pe.nameFirst,'') || ' ' || COALESCE(pe.nameLast,'')) AS name
      FROM ranked r
      JOIN People pe ON pe.playerID = r.playerID
      JOIN have ON have.yearID = r.yearID AND have.lgID = r.lgID
      WHERE r.rnk = 1 {nonzero}
      ORDER BY r.yearID DESC, r.lgID, name""".format(
        decided=DECIDED, haslg=has_lg("t"), p=prefix, sums=sum_cols,
        table=table, floor=MIN_SCHEDULE, expr=expr, order=order, qual=qual,
        src=src, nonzero=nonzero)

    out = []
    for r in conn.execute(sql, (y0, y1, y0, y1, y0, y1)):
        key = (r["yearID"], r["lgID"])
        if out and (out[-1]["yearID"], out[-1]["lgID"]) == key:
            out[-1]["leaders"].append({"name": r["name"], "teamID": r["teamID"]})
            out[-1]["tied"] += 1
        else:
            out.append({"yearID": r["yearID"], "lgID": r["lgID"],
                        "value": r["value"], "tied": 1,
                        "leaders": [{"name": r["name"], "teamID": r["teamID"]}]})
    return {"rows": out, "stat": stat, "cat": cat, "start": y0, "end": y1}


def api_leaders(q, conn):
    year = int(q.get("year", ["0"])[0])
    stat = q.get("stat", ["HR"])[0]
    cat = q.get("cat", ["batting"])[0]
    limit = min(int(q.get("limit", ["10"])[0]), 50)
    rows = _leaders(conn, cat, stat, year, year, limit, per_season=True)
    return {"leaders": rows, "stat": stat, "cat": cat, "year": year}


def api_best_seasons(q, conn):
    """Best individual seasons in a span — one row per player-season.

    The other span modes aggregate: over all years they answer "most career
    home runs" (Bonds 762). This ranks the seasons themselves, so the same
    span answers "best home run season" (Bonds 73 in 2001) instead.
    """
    y0 = int(q.get("start", ["0"])[0])
    y1 = int(q.get("end", ["0"])[0])
    if y1 < y0:
        y0, y1 = y1, y0
    stat = q.get("stat", ["HR"])[0]
    cat = q.get("cat", ["batting"])[0]
    limit = min(int(q.get("limit", ["10"])[0]), 50)
    rows = _leaders(conn, cat, stat, y0, y1, limit, per_season=True)
    return {"leaders": rows, "stat": stat, "cat": cat, "start": y0, "end": y1}


def api_leaders_range(q, conn):
    y0 = int(q.get("start", ["0"])[0])
    y1 = int(q.get("end", ["0"])[0])
    if y1 < y0:
        y0, y1 = y1, y0
    stat = q.get("stat", ["HR"])[0]
    cat = q.get("cat", ["batting"])[0]
    limit = min(int(q.get("limit", ["10"])[0]), 50)
    rows = _leaders(conn, cat, stat, y0, y1, limit, per_season=False)
    return {"leaders": rows, "stat": stat, "cat": cat, "start": y0, "end": y1}


ROUTES = {
    "meta": api_meta,
    "search": api_search,
    "teams": api_teams,
    "postseason": api_postseason,
    "roster": api_roster,
    "leaders": api_leaders,
    "leaders_range": api_leaders_range,
    "franchises": api_franchises,
    "season_leaders": api_season_leaders,
    "best_seasons": api_best_seasons,
    "history": api_history,
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC, **kwargs)

    def log_message(self, fmt, *args):
        pass  # quiet

    def do_GET(self):
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        if parts and parts[0] == "api":
            q = parse_qs(parsed.query)
            conn = db()
            try:
                if len(parts) >= 3 and parts[1] == "player":
                    payload = api_player(parts[2], conn)
                elif len(parts) >= 3 and parts[1] == "franchise":
                    payload = api_franchise(parts[2], conn)
                elif len(parts) >= 2 and parts[1] in ROUTES:
                    payload = ROUTES[parts[1]](q, conn)
                else:
                    self.send_error(404)
                    return
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (ValueError, KeyError) as e:
                body = json.dumps({"error": str(e)}).encode()
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            finally:
                conn.close()
        else:
            super().do_GET()


def ensure_db():
    """Build/rebuild lahman.sqlite whenever the CSVs are newer than it."""
    csv_dir = os.path.join(BASE, "data", "csv")
    if not os.path.isdir(csv_dir):
        sys.exit("data/csv not found — run: python3 update_data.py")
    csv_mtime = max(
        os.path.getmtime(os.path.join(csv_dir, f))
        for f in os.listdir(csv_dir) if f.endswith(".csv"))
    if not os.path.exists(DB_PATH) or os.path.getmtime(DB_PATH) < csv_mtime:
        print("Database missing or older than CSVs — rebuilding...")
        import build_db
        build_db.main()


def main():
    args = [a for a in sys.argv[1:] if a != "--lan"]
    lan = "--lan" in sys.argv[1:]
    port = int(args[0]) if args else 8000
    ensure_db()
    host = "0.0.0.0" if lan else "127.0.0.1"
    server = ThreadingHTTPServer((host, port), Handler)
    print("Baseball Records running at http://127.0.0.1:%d" % port)
    if lan:
        import socket
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            print("On your iPhone/iPad (same Wi-Fi): http://%s:%d" % (ip, port))
        except OSError:
            print("LAN mode on — open http://<this-Mac's-IP>:%d from your device" % port)
    server.serve_forever()


if __name__ == "__main__":
    main()
