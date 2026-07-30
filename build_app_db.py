#!/usr/bin/env python3
"""Build baseball-app.sqlite — the slim database bundled with the iOS app.

Reads the curated CSVs in docs/data/ rather than data/csv/, so the column
subset is defined in exactly one place: build_site.py already decided what the
frontend needs, and the app needs the same. Run build_site.py first.

That also means the derived franchise tables come along already flattened, so
the app never has to reproduce franchises.py at runtime.

Table names match the ones app.py queries (People, Batting, AwardsPlayers, ...)
rather than the lowercase CSV filenames, so ported SQL runs unchanged.

Usage: python3 build_app_db.py
"""
import os
import sqlite3
import sys

from build_db import sniff_types

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "docs", "data")
DB_PATH = os.path.join(BASE, "baseball-app.sqlite")

# CSV file -> table name as app.py spells it
TABLES = {
    "people.csv": "People",
    "batting.csv": "Batting",
    "pitching.csv": "Pitching",
    "fielding.csv": "Fielding",
    "teams.csv": "Teams",
    "managers.csv": "Managers",
    "awards.csv": "AwardsPlayers",
    "allstar.csv": "AllstarFull",
    "hof.csv": "HallOfFame",
    "seriespost.csv": "SeriesPost",
    "franchises.csv": "Franchises",
    "franchise_eras.csv": "FranchiseEras",
    "franchise_parks.csv": "FranchiseParks",
}

# Only what the app's queries actually sort or filter on. Every index costs
# bundle size, and this database is read-only and never written on device.
#
# No standalone ("playerID",) on the big three: SQLite uses the leftmost prefix
# of ("playerID", "yearID") for playerID-only lookups, so a separate index just
# duplicates it. Measured at 6.4 MB of pure duplication across the three.
INDEXES = {
    "Batting": [("yearID",), ("playerID", "yearID")],
    "Pitching": [("yearID",), ("playerID", "yearID")],
    "Fielding": [("playerID", "yearID")],
    "People": [("nameLast",)],
    "Teams": [("yearID",), ("franchID",), ("teamID", "yearID")],
    "Managers": [("playerID",), ("teamID", "yearID")],
    "AwardsPlayers": [("playerID",)],
    "AllstarFull": [("playerID",)],
    "HallOfFame": [("playerID",)],
    "SeriesPost": [("yearID",), ("teamIDwinner",), ("teamIDloser",)],
    "FranchiseEras": [("franchID",)],
    "FranchiseParks": [("franchID",)],
}


def load(conn, path, table):
    """Load one CSV into `table`, typing columns from a sample of rows."""
    import csv

    header, types = sniff_types(path)
    cols = ", ".join('"%s" %s' % (h, t) for h, t in zip(header, types))
    conn.execute('DROP TABLE IF EXISTS "%s"' % table)
    conn.execute('CREATE TABLE "%s" (%s)' % (table, cols))
    ins = 'INSERT INTO "%s" VALUES (%s)' % (table, ", ".join("?" * len(header)))
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        next(reader)  # header
        batch = []
        for row in reader:
            row = row[: len(header)] + [""] * (len(header) - len(row))
            batch.append([v if v != "" else None for v in row])
            if len(batch) >= 5000:
                conn.executemany(ins, batch)
                batch = []
        if batch:
            conn.executemany(ins, batch)
    n = conn.execute('SELECT COUNT(*) FROM "%s"' % table).fetchone()[0]
    print("  %-16s %8d rows" % (table, n))


def main():
    if not os.path.isdir(DATA_DIR):
        sys.exit("docs/data not found — run build_site.py first: %s" % DATA_DIR)
    missing = [n for n in TABLES if not os.path.exists(os.path.join(DATA_DIR, n))]
    if missing:
        sys.exit("missing CSVs in docs/data (run build_site.py): %s"
                 % ", ".join(sorted(missing)))

    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    print("Building %s" % DB_PATH)
    for name in sorted(TABLES):
        load(conn, os.path.join(DATA_DIR, name), TABLES[name])

    print("Creating indexes...")
    for table, idxs in INDEXES.items():
        for cols in idxs:
            conn.execute(
                'CREATE INDEX IF NOT EXISTS "ix_%s_%s" ON "%s" (%s)'
                % (table, "_".join(cols), table,
                   ", ".join('"%s"' % c for c in cols))
            )
    conn.execute("ANALYZE")
    conn.commit()
    # Read-only on device, so reclaim every page the drops and indexes left.
    conn.execute("VACUUM")
    conn.close()
    print("Done. %s (%.1f MB)" % (DB_PATH, os.path.getsize(DB_PATH) / 1e6))


if __name__ == "__main__":
    main()
