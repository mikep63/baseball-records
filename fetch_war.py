#!/usr/bin/env python3
"""Fetch Baseball-Reference's WAR files into data/war/.

Usage:
  python3 fetch_war.py            # download, slim, verify, install
  python3 fetch_war.py --check    # report what is on disk, download nothing

Lahman has no adjusted metric of any kind — no WAR, no park factor, no OPS+.
These two flat files are the whole of the gap, and they need no crosswalk work:
they are keyed on `player_ID`, which *is* the `bbrefID` already in People.csv
(22,995 of 24,270 people carry one).

**These files do not live in data/csv/.** update_data.py renames that whole
directory aside and moves the freshly-unzipped Lahman folder into place, so
anything of ours in there is destroyed on the next yearly refresh.

**The two sources run on different clocks.** Lahman ships once a year; these
are `war_daily` and are rebuilt continuously, so B-Ref is nearly always ahead
— it carried 2026 while Lahman still ended at 2025. That is harmless on its
own, since a WAR row for a season Lahman has never heard of joins to nothing.
It stops being harmless if the two are fetched months apart: a complete season
of batting lines then pairs with a partial season's WAR, which does not error
and does not look wrong, it just reads low. Two guards, and both are cheap —
update_data.py fetches Lahman and these together so they are always a
consistent pair, and build_db.py drops WAR rows past Lahman's own last season
so an incomplete tail cannot attach itself to a complete one.
"""
import argparse
import csv
import os
import shutil
import sys
import tempfile
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
WAR_DIR = os.path.join(BASE, "data", "war")

SOURCES = {
    "war_bat": "https://www.baseball-reference.com/data/war_daily_bat.txt",
    "war_pitch": "https://www.baseball-reference.com/data/war_daily_pitch.txt",
}

# Only the columns anything reads. The full files are 35.6 MB and 15.4 MB of
# which most is the intermediate arithmetic behind WAR — xRA, the pythagorean
# exponents, the replacement-level run environments. Keeping every column would
# commit 51 MB to a repository whose entire published site is 18 MB.
#
# `pitcher` is kept on the batting side because it is what separates a pitcher's
# value at the plate from a position player's; WAR_off/WAR_def because they are
# the only fielding value in the app at all, and the reason Ozzie Smith (76.9,
# of which 44.2 defensive) outranks Tony Gwynn (69.2) despite being the far
# worse hitter. The runs_* components behind them are deliberately not kept:
# they are a different feature, and adding them later is one line here.
KEEP = {
    "war_bat": ["player_ID", "year_ID", "team_ID", "stint_ID", "lg_ID",
                "pitcher", "WAR", "WAR_off", "WAR_def", "OPS_plus"],
    "war_pitch": ["player_ID", "year_ID", "team_ID", "stint_ID", "lg_ID",
                  "WAR", "ERA_plus"],
}

# Refuse a truncated download the same way update_data.py refuses a truncated
# Lahman zip: a cut-off file parses cleanly up to the byte it stops at, so
# "it downloaded" proves nothing. Floors are ~90% of the real counts.
MIN_ROWS = {"war_bat": 100000, "war_pitch": 50000}

# Columns written as whole numbers. The source carries OPS+ and ERA+ at full
# float precision — "1045.1000000000000", "-100.0000000000" — which is 13
# digits of noise on a statistic that is quoted as an integer everywhere it
# has ever been published.
ROUND_INT = {"OPS_plus", "ERA_plus"}


def clean(col, v):
    """Normalise one source value.

    The source writes an absent value as the four characters NULL, not as an
    empty field: 10,207 OPS+ and 1,890 ERA+ rows. build_db.py's load_csv maps
    "" to SQL NULL and everything else to itself, so left alone these become
    the *string* "NULL" in a column sniff_types would then read as TEXT — and
    every comparison against it silently stops being arithmetic."""
    if v is None or v == "" or v == "NULL":
        return ""
    if col in ROUND_INT:
        try:
            return str(int(round(float(v))))
        except (ValueError, TypeError):
            return ""
    return v


def slim(src, name):
    """Read the downloaded file, keep the columns in KEEP, drop rows with no
    WAR. Returns (rows, header, max_year).

    A row with no WAR is not a gap in the data: 12,023 of them are pitchers who
    never came to the plate, and every one of the 70,651 position-player seasons
    carries a value. Storing them would put an empty column in the database and
    invite a reader to treat it as a zero."""
    keep = KEEP[name]
    out = []
    max_year = 0
    with open(src, newline="", encoding="utf-8", errors="replace") as f:
        reader = csv.DictReader(f)
        missing = [c for c in keep if c not in (reader.fieldnames or [])]
        if missing:
            sys.exit("%s: source is missing expected columns: %s"
                     % (name, ", ".join(missing)))
        for r in reader:
            if r.get("WAR") in ("", "NULL", None):
                continue
            out.append([clean(c, r.get(c)) for c in keep])
            try:
                y = int(r["year_ID"])
            except (ValueError, TypeError):
                continue
            if y > max_year:
                max_year = y
    return out, keep, max_year


def on_disk(name):
    """(rows, max_year) already installed, or (0, 0)."""
    path = os.path.join(WAR_DIR, name + ".csv")
    if not os.path.exists(path):
        return 0, 0
    rows = max_year = 0
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for r in reader:
            rows += 1
            try:
                y = int(r["year_ID"])
            except (ValueError, TypeError, KeyError):
                continue
            if y > max_year:
                max_year = y
    return rows, max_year


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "baseball-records-updater"})
    with urllib.request.urlopen(req, timeout=180) as resp, open(dest, "wb") as out:
        shutil.copyfileobj(resp, out)
    return os.path.getsize(dest)


def fetch_all(quiet=False):
    """Download, verify and install both files.

    Returns a dict of name -> (rows, max_year), or None if nothing was
    installed. Raises nothing on a network failure: WAR is an addition to
    Lahman, not a precondition for it, so a yearly update that cannot reach
    B-Ref should keep going rather than abort with the Lahman half done.
    """
    results = {}
    with tempfile.TemporaryDirectory() as tmp:
        staged = {}
        for name, url in SOURCES.items():
            old_rows, old_year = on_disk(name)
            raw = os.path.join(tmp, name + ".txt")
            if not quiet:
                print("Downloading %s ..." % url)
            try:
                size = download(url, raw)
            except Exception as e:                      # noqa: BLE001 - see docstring
                print("  WARNING: could not fetch %s (%s)" % (name, e))
                print("  Keeping the %s already in data/war/." % name)
                return None
            if not quiet:
                print("  %.1f MB" % (size / 1e6))

            rows, header, max_year = slim(raw, name)
            if len(rows) < MIN_ROWS[name]:
                print("  WARNING: %s has only %d rows (expected >= %d) — refusing "
                      "to replace what is on disk." % (name, len(rows), MIN_ROWS[name]))
                return None
            if old_year and max_year < old_year:
                print("  WARNING: %s ends in %d but what is on disk ends in %d — "
                      "refusing to downgrade." % (name, max_year, old_year))
                return None

            staged[name] = (rows, header)
            results[name] = (len(rows), max_year, old_rows, old_year)

        # Both verified before either is installed, so a good file is never
        # left beside a rejected one.
        if not os.path.isdir(WAR_DIR):
            os.makedirs(WAR_DIR)
        for name, (rows, header) in staged.items():
            path = os.path.join(WAR_DIR, name + ".csv")
            with open(path, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(header)
                w.writerows(rows)
    return results


def report(results):
    for name in sorted(results):
        rows, max_year, old_rows, old_year = results[name]
        if not old_rows:
            print("  %-10s %7d rows, through %d" % (name, rows, max_year))
        elif max_year == old_year:
            print("  %-10s %7d rows (%+d), still through %d"
                  % (name, rows, rows - old_rows, max_year))
        else:
            print("  %-10s %7d rows (%+d), %d -> %d"
                  % (name, rows, rows - old_rows, old_year, max_year))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="report what is installed and exit")
    args = ap.parse_args()

    if args.check:
        if not os.path.isdir(WAR_DIR):
            print("data/war/ does not exist — run python3 fetch_war.py")
            return
        for name in sorted(SOURCES):
            rows, max_year = on_disk(name)
            if rows:
                print("  %-10s %7d rows, through %d" % (name, rows, max_year))
            else:
                print("  %-10s not installed" % name)
        return

    results = fetch_all()
    if results is None:
        print("WAR files unchanged.")
        return
    print("WAR data installed in data/war/:")
    report(results)


if __name__ == "__main__":
    main()
