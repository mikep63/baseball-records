#!/usr/bin/env python3
"""Attach Baseball-Reference's WAR rows to Lahman's, in Lahman's vocabulary.

Called by build_db.py once the CSVs are loaded. It writes two columns onto
each war table — `playerID` and `teamID` — so every query in app.py is a plain
join and none of the matching below leaks into the view layer.

**The player key is exact and needs no heuristic.** B-Ref's `player_ID` *is*
Lahman's `bbrefID`; SABR maintains it, and 22,995 of 24,270 people carry one.

**The team key is not.** The two sources spell clubs differently, and
systematically: Lahman uses Retrosheet-style codes (CHN, CHA, SLN, NYA) where
B-Ref uses colloquial ones (CHC, CHW, STL, NYY). Joining on the code as written
matches 57.6% of rows and silently drops the other 42%, which is worse than not
joining at all — it would take a WAR column away from four seasons in ten with
nothing on the page to say why. Joining on `stint_ID` instead is no better: the
two number stints differently and it matches 84.7%.

So the codes are learned from the data rather than written down. 91.8% of
player-seasons have exactly one row on each side, where the pairing is certain
whatever the clubs are called; those seasons vote on what each B-Ref code means
in each year, and the remaining 8.2% are resolved with the result. That takes
the per-row match to 98.4%, and a table nobody maintains by hand cannot go
stale when either source adds a club.

Anything still unresolved keeps a NULL teamID and simply shows no WAR. A blank
is the honest answer to "we could not identify this row"; a wrong number is not.
"""
import collections

# Which Lahman table each war table describes, and the columns that identify a
# row in it. Pitching is keyed the same way Batting is.
SOURCES = {
    "war_bat": "Batting",
    "war_pitch": "Pitching",
}


def _table_exists(conn, name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _add_column(conn, table, col, decl="TEXT"):
    """ALTER TABLE ... ADD COLUMN, tolerating a column that is already there.

    build_db.py drops and recreates every table from the CSV each run, so in
    practice this is always the first time; the guard is for anyone calling
    link() twice against one database by hand."""
    cols = {r[1] for r in conn.execute('PRAGMA table_info("%s")' % table)}
    if col not in cols:
        conn.execute('ALTER TABLE "%s" ADD COLUMN "%s" %s' % (table, col, decl))


def _lahman_max_year(conn):
    row = conn.execute("SELECT MAX(yearID) FROM Batting").fetchone()
    return row[0] if row and row[0] is not None else None


def link(conn, verbose=True):
    """Resolve both war tables against Lahman. Returns a dict of stats."""
    stats = {}
    if not _table_exists(conn, "People"):
        return stats

    bbref = {}
    for pid, bb in conn.execute(
        "SELECT playerID, bbrefID FROM People WHERE bbrefID IS NOT NULL AND bbrefID <> ''"
    ):
        bbref[bb] = pid

    max_year = _lahman_max_year(conn)

    for war_table, lahman_table in SOURCES.items():
        if not _table_exists(conn, war_table) or not _table_exists(conn, lahman_table):
            continue
        stats[war_table] = _link_one(
            conn, war_table, lahman_table, bbref, max_year, verbose)
    return stats


def _link_one(conn, war_table, lahman_table, bbref, max_year, verbose):
    # An in-progress season on the B-Ref side must never reach a complete one
    # on Lahman's. These files are rebuilt daily and are normally a season
    # ahead — they carried 2026 while Lahman ended at 2025 — so a row kept here
    # would sit harmlessly unjoined until the day Lahman ships that season, and
    # would then pair a full year of batting lines with a partial year's WAR.
    # That does not error and does not look wrong; the column just reads low.
    dropped = 0
    if max_year is not None:
        dropped = conn.execute(
            'SELECT COUNT(*) FROM "%s" WHERE CAST(year_ID AS INTEGER) > ?' % war_table,
            (max_year,)).fetchone()[0]
        conn.execute('DELETE FROM "%s" WHERE CAST(year_ID AS INTEGER) > ?' % war_table,
                     (max_year,))

    _add_column(conn, war_table, "playerID")
    _add_column(conn, war_table, "teamID")

    # Lahman's side: (playerID, yearID) -> [teamID, ...] in stint order.
    lahman = collections.defaultdict(list)
    for pid, yr, tm in conn.execute(
            'SELECT playerID, yearID, teamID FROM "%s" ORDER BY playerID, yearID, stint'
            % lahman_table):
        lahman[(pid, yr)].append(tm)

    # B-Ref's side, carrying each row's rowid so the resolved values can be
    # written back to exactly the row they came from.
    war = collections.defaultdict(list)
    unknown_player = 0
    for rowid, bb, yr, tm in conn.execute(
            'SELECT rowid, player_ID, year_ID, team_ID FROM "%s" ORDER BY rowid'
            % war_table):
        pid = bbref.get(bb)
        if pid is None:
            unknown_player += 1
            continue
        try:
            yr = int(yr)
        except (TypeError, ValueError):
            continue
        war[(pid, yr)].append((rowid, tm))

    # Pass 1 — the seasons that need no crosswalk. One row on each side means
    # the pairing is certain however the two spell the club, so Lahman's own
    # teamID is copied across and the pair also votes on what that B-Ref code
    # means that year.
    resolved = {}
    vote_year = collections.defaultdict(collections.Counter)
    vote_any = collections.defaultdict(collections.Counter)
    for key, rows in war.items():
        seats = lahman.get(key)
        if not seats:
            continue
        if len(rows) == 1 and len(seats) == 1:
            rowid, bref_tm = rows[0]
            resolved[rowid] = seats[0]
            vote_year[(bref_tm, key[1])][seats[0]] += 1
            vote_any[bref_tm][seats[0]] += 1

    xwalk_year = {k: c.most_common(1)[0][0] for k, c in vote_year.items()}
    xwalk_any = {k: c.most_common(1)[0][0] for k, c in vote_any.items()}

    # Pass 2 — everything else, resolved with what pass 1 learned. The
    # year-specific reading wins over the career-wide one because club codes
    # are reused across eras: Lahman has more than one WS1.
    for key, rows in war.items():
        seats = lahman.get(key)
        if not seats:
            continue
        for rowid, bref_tm in rows:
            if rowid in resolved:
                continue
            tm = xwalk_year.get((bref_tm, key[1])) or xwalk_any.get(bref_tm)
            # Only accept a reading that puts him on a club Lahman agrees he
            # played for that season. Without this a learned code could place
            # a traded player on the wrong half of his year.
            if tm in seats:
                resolved[rowid] = tm

    conn.executemany(
        'UPDATE "%s" SET teamID = ? WHERE rowid = ?' % war_table,
        [(tm, rid) for rid, tm in resolved.items()])
    conn.executemany(
        'UPDATE "%s" SET playerID = ? WHERE rowid = ?' % war_table,
        [(bbref[bb], rid) for rid, bb in conn.execute(
            'SELECT rowid, player_ID FROM "%s"' % war_table).fetchall()
         if bb in bbref])

    conn.execute(
        'CREATE INDEX IF NOT EXISTS "ix_%s_link" ON "%s" (playerID, year_ID, teamID)'
        % (war_table, war_table))

    total = conn.execute('SELECT COUNT(*) FROM "%s"' % war_table).fetchone()[0]
    linked = conn.execute(
        'SELECT COUNT(*) FROM "%s" WHERE playerID IS NOT NULL AND teamID IS NOT NULL'
        % war_table).fetchone()[0]
    out = {"rows": total, "linked": linked, "dropped_future": dropped,
           "unknown_player": unknown_player, "codes": len(xwalk_any)}
    if verbose:
        print("  %-22s %8d rows, %d linked (%.1f%%), %d codes learned"
              % (war_table, total, linked,
                 100.0 * linked / total if total else 0.0, len(xwalk_any)))
        if dropped:
            print("  %-22s dropped %d rows past Lahman's %d season"
                  % ("", dropped, _lahman_max_year(conn)))
    return out
