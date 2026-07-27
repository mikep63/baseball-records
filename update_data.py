#!/usr/bin/env python3
"""Update the Lahman data to the latest release and rebuild lahman.sqlite.

Usage:
  python3 update_data.py                 # download latest from the default mirror
  python3 update_data.py --zip file.zip  # use an already-downloaded zip instead
  python3 update_data.py --url <url>     # use a different source zip URL

The zip just needs to contain the standard Lahman CSVs (Batting.csv,
People.csv, ...) in some folder; the script finds them wherever they live,
so it keeps working when the source renames its folder each year
(lahman_1871-2025_csv, lahman_1871-2026_csv, ...).
"""
import argparse
import csv
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile

BASE = os.path.dirname(os.path.abspath(__file__))
CSV_DIR = os.path.join(BASE, "data", "csv")
DEFAULT_URL = "https://github.com/myceliumdata/lahman-seed/archive/refs/heads/main.zip"

# Must all be present for the zip to be accepted as a Lahman release
REQUIRED = ["People.csv", "Batting.csv", "Pitching.csv", "Fielding.csv", "Teams.csv"]


def current_max_year():
    path = os.path.join(CSV_DIR, "Batting.csv")
    if not os.path.exists(path):
        return None
    max_year = 0
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        yi = header.index("yearID")
        for row in reader:
            try:
                y = int(row[yi])
            except (ValueError, IndexError):
                continue
            if y > max_year:
                max_year = y
    return max_year or None


def download(url, dest):
    print("Downloading %s ..." % url)
    req = urllib.request.Request(url, headers={"User-Agent": "baseball-records-updater"})
    with urllib.request.urlopen(req) as resp, open(dest, "wb") as out:
        shutil.copyfileobj(resp, out)
    print("  %.1f MB" % (os.path.getsize(dest) / 1e6))


def find_csv_root(zf):
    """Return the zip folder prefix that contains the Lahman CSVs."""
    dirs = {}
    for name in zf.namelist():
        base = os.path.basename(name)
        if base.endswith(".csv"):
            dirs.setdefault(os.path.dirname(name), set()).add(base)
    for d, files in dirs.items():
        if all(r in files for r in REQUIRED):
            return d
    sys.exit("No folder in the zip contains all of: %s" % ", ".join(REQUIRED))


def extract(zip_path, work_dir):
    """Extract the Lahman CSVs (flat) into work_dir and return the file list."""
    out = []
    with zipfile.ZipFile(zip_path) as zf:
        root = find_csv_root(zf)
        print("Found CSVs under: %s" % (root or "(zip root)"))
        for name in zf.namelist():
            if os.path.dirname(name) != root:
                continue
            base = os.path.basename(name)
            if not (base.endswith(".csv") or base.lower().startswith("readme")):
                continue
            target = os.path.join(work_dir, base)
            with zf.open(name) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
            out.append(base)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default=DEFAULT_URL, help="source zip URL")
    ap.add_argument("--zip", dest="zip_path", help="use a local zip file instead of downloading")
    ap.add_argument("--keep-db", action="store_true", help="skip rebuilding lahman.sqlite")
    args = ap.parse_args()

    old_year = current_max_year()

    with tempfile.TemporaryDirectory() as tmp:
        zip_path = args.zip_path
        if not zip_path:
            zip_path = os.path.join(tmp, "lahman.zip")
            download(args.url, zip_path)
        elif not os.path.exists(zip_path):
            sys.exit("zip not found: %s" % zip_path)

        work = os.path.join(tmp, "csv")
        os.makedirs(work)
        files = extract(zip_path, work)
        print("Extracted %d files" % len(files))

        # sanity check the new data before touching data/csv
        new_batting = os.path.join(work, "Batting.csv")
        new_year = 0
        with open(new_batting, newline="", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            header = next(reader)
            if "playerID" not in header or "yearID" not in header:
                sys.exit("Batting.csv in the new data looks wrong (missing playerID/yearID)")
            yi = header.index("yearID")
            nrows = 0
            for row in reader:
                nrows += 1
                try:
                    y = int(row[yi])
                except (ValueError, IndexError):
                    continue
                if y > new_year:
                    new_year = y
        if nrows < 100000:
            sys.exit("New Batting.csv has only %d rows — refusing to replace data" % nrows)
        if old_year and new_year < old_year:
            sys.exit("New data ends in %d but current data ends in %d — refusing to downgrade"
                     % (new_year, old_year))

        # swap in the new CSVs
        old_dir = CSV_DIR + ".old"
        if os.path.exists(old_dir):
            shutil.rmtree(old_dir)
        if os.path.exists(CSV_DIR):
            os.rename(CSV_DIR, old_dir)
        shutil.move(work, CSV_DIR)
        # move any readme up to data/ like before
        for f in os.listdir(CSV_DIR):
            if f.lower().startswith("readme"):
                shutil.move(os.path.join(CSV_DIR, f), os.path.join(BASE, "data", f))
        if os.path.exists(old_dir):
            shutil.rmtree(old_dir)

    if old_year == new_year:
        print("Data refreshed; still ends at the %d season (no new season yet)." % new_year)
    else:
        print("Data updated: %s -> %d season." % (old_year or "?", new_year))

    if args.keep_db:
        print("Skipping database rebuild (--keep-db); app.py will rebuild on next start.")
        return
    print()
    import build_db
    build_db.main()
    if os.path.isdir(os.path.join(BASE, "docs")):
        print()
        import build_site
        build_site.main()
        print("Commit and push docs/ to update the GitHub Pages site.")
    print("\nAll set — a running app.py picks up the new data automatically.")


if __name__ == "__main__":
    main()
