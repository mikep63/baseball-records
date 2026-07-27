#!/usr/bin/env python3
"""Build lahman.sqlite from the CSV files in data/csv/.

Usage: python3 build_db.py
"""
import csv
import os
import sqlite3
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
CSV_DIR = os.path.join(BASE, "data", "csv")
DB_PATH = os.path.join(BASE, "lahman.sqlite")

# Indexes to create: table -> list of column tuples
INDEXES = {
    "Batting": [("playerID",), ("yearID",), ("yearID", "teamID")],
    "Pitching": [("playerID",), ("yearID",), ("yearID", "teamID")],
    "Fielding": [("playerID",), ("yearID", "teamID")],
    "BattingPost": [("playerID",), ("yearID",)],
    "PitchingPost": [("playerID",), ("yearID",)],
    "FieldingPost": [("playerID",)],
    "Appearances": [("playerID",), ("yearID", "teamID")],
    "People": [("playerID",), ("nameLast",)],
    "Teams": [("yearID",), ("teamID",)],
    "AwardsPlayers": [("playerID",)],
    "AllstarFull": [("playerID",)],
    "HallOfFame": [("playerID",)],
    "Salaries": [("playerID",), ("yearID", "teamID")],
}


def sniff_types(path, sample_rows=2000):
    """Return per-column SQLite type based on a sample of rows."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        ncols = len(header)
        is_int = [True] * ncols
        is_real = [True] * ncols
        seen = [False] * ncols
        for i, row in enumerate(reader):
            if i >= sample_rows:
                break
            for c in range(min(ncols, len(row))):
                v = row[c].strip()
                if v == "":
                    continue
                seen[c] = True
                if is_int[c]:
                    try:
                        int(v)
                    except ValueError:
                        is_int[c] = False
                if not is_int[c] and is_real[c]:
                    try:
                        float(v)
                    except ValueError:
                        is_real[c] = False
    types = []
    for c in range(ncols):
        if not seen[c]:
            types.append("TEXT")
        elif is_int[c]:
            types.append("INTEGER")
        elif is_real[c]:
            types.append("REAL")
        else:
            types.append("TEXT")
    return header, types


def load_csv(conn, path):
    table = os.path.splitext(os.path.basename(path))[0]
    header, types = sniff_types(path)
    cols = ", ".join('"%s" %s' % (h, t) for h, t in zip(header, types))
    conn.execute('DROP TABLE IF EXISTS "%s"' % table)
    conn.execute('CREATE TABLE "%s" (%s)' % (table, cols))
    placeholders = ", ".join("?" * len(header))
    ins = 'INSERT INTO "%s" VALUES (%s)' % (table, placeholders)
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        next(reader)  # header
        batch = []
        for row in reader:
            # pad/trim ragged rows, convert '' -> None
            row = row[: len(header)] + [""] * (len(header) - len(row))
            batch.append([v if v != "" else None for v in row])
            if len(batch) >= 5000:
                conn.executemany(ins, batch)
                batch = []
        if batch:
            conn.executemany(ins, batch)
    n = conn.execute('SELECT COUNT(*) FROM "%s"' % table).fetchone()[0]
    print("  %-22s %8d rows" % (table, n))
    return table


def main():
    if not os.path.isdir(CSV_DIR):
        sys.exit("CSV directory not found: %s" % CSV_DIR)
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    print("Building %s" % DB_PATH)
    for name in sorted(os.listdir(CSV_DIR)):
        if name.endswith(".csv"):
            load_csv(conn, os.path.join(CSV_DIR, name))
    print("Creating indexes...")
    for table, idxs in INDEXES.items():
        for cols in idxs:
            idx_name = "ix_%s_%s" % (table, "_".join(cols))
            conn.execute(
                'CREATE INDEX IF NOT EXISTS "%s" ON "%s" (%s)'
                % (idx_name, table, ", ".join('"%s"' % c for c in cols))
            )
    conn.execute("ANALYZE")
    conn.commit()
    conn.close()
    size_mb = os.path.getsize(DB_PATH) / 1e6
    print("Done. %s (%.1f MB)" % (DB_PATH, size_mb))


if __name__ == "__main__":
    main()
