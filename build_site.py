#!/usr/bin/env python3
"""Build the static, serverless site into docs/ (for GitHub Pages / offline PWA).

Exports compact data files from data/csv, copies the frontend from static/,
and generates the PWA pieces (manifest, icons, service worker).

Usage: python3 build_site.py
"""
import csv
import hashlib
import json
import os
import shutil
import struct
import zlib

import franchises

BASE = os.path.dirname(os.path.abspath(__file__))
CSV_DIR = os.path.join(BASE, "data", "csv")
DOCS = os.path.join(BASE, "docs")
DATA_OUT = os.path.join(DOCS, "data")

# ------------------------------------------------------------- data exports

def read_csv(name):
    with open(os.path.join(CSV_DIR, name), newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            yield row


def write_csv(name, header, rows):
    path = os.path.join(DATA_OUT, name)
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)
    print("  %-14s %8d rows  %6.1f KB" % (name, sum(1 for _ in open(path)) - 1,
                                          os.path.getsize(path) / 1024))


def export_franchises():
    """Franchise history, reconstructed from the per-season Teams rows.

    Two files: one listing row per franchise, and the name/location eras
    behind it (kind tells them apart) for the franchise detail page.
    """
    built = franchises.build(list(read_csv("Teams.csv")),
                             list(read_csv("TeamsFranchises.csv")),
                             list(read_csv("Parks.csv")))
    write_csv("franchises.csv",
              ["franchID", "name", "active", "firstYear", "lastYear",
               "seasons", "W", "L", "pennants", "titles", "teamID", "lgID",
               "nameCount", "former"],
              [[s["franchID"], s["name"], s["active"], s["firstYear"],
                s["lastYear"], s["seasons"], s["W"], s["L"], s["pennants"],
                s["titles"], s["teamID"], s["lgID"], s["nameCount"],
                # pipe-joined so the list survives as one CSV field
                "|".join(s["former"])]
               for s in (franchises.summary(f) for f in built)])

    era_rows = []
    for f in built:
        for e in f["eras"]:
            era_rows.append([f["franchID"], "name", e["name"], e["firstYear"],
                             e["lastYear"], e["teamID"], e["lgID"]])
        for l in f["locations"]:
            era_rows.append([f["franchID"], "location", l["location"],
                             l["firstYear"], l["lastYear"], "", ""])
    write_csv("franchise_eras.csv",
              ["franchID", "kind", "label", "firstYear", "lastYear",
               "teamID", "lgID"], era_rows)


def export_data():
    os.makedirs(DATA_OUT, exist_ok=True)
    print("Exporting data files...")

    # career games from Appearances (for search result ordering)
    career_g = {}
    for r in read_csv("Appearances.csv"):
        try:
            career_g[r["playerID"]] = career_g.get(r["playerID"], 0) + int(r["G_all"] or 0)
        except ValueError:
            pass

    write_csv("people.csv",
              ["playerID", "nameFirst", "nameLast", "birthYear", "birthCity",
               "birthState", "birthCountry", "bats", "throws", "height",
               "weight", "debut", "finalGame", "careerG"],
              [[r["playerID"], r["nameFirst"], r["nameLast"], r["birthYear"],
                r["birthCity"], r["birthState"], r["birthCountry"], r["bats"],
                r["throws"], r["height"], r["weight"], r["debut"],
                r["finalGame"], career_g.get(r["playerID"], 0)]
               for r in read_csv("People.csv")])

    bat_cols = ["playerID", "yearID", "stint", "teamID", "lgID", "G", "AB",
                "R", "H", "2B", "3B", "HR", "RBI", "SB", "BB", "SO", "HBP",
                "SH", "SF"]
    write_csv("batting.csv", bat_cols,
              [[r[c] for c in bat_cols] for r in read_csv("Batting.csv")])

    pit_cols = ["playerID", "yearID", "stint", "teamID", "lgID", "W", "L",
                "G", "GS", "CG", "SHO", "SV", "IPouts", "H", "ER", "HR",
                "BB", "SO"]
    write_csv("pitching.csv", pit_cols,
              [[r[c] for c in pit_cols] for r in read_csv("Pitching.csv")])

    fld_cols = ["playerID", "yearID", "teamID", "POS", "G", "PO", "A", "E", "DP"]
    write_csv("fielding.csv", fld_cols,
              [[r[c] for c in fld_cols] for r in read_csv("Fielding.csv")])

    team_cols = ["yearID", "lgID", "divID", "teamID", "franchID", "name",
                 "Rank", "G", "W", "L", "R", "RA", "WSWin", "LgWin"]
    write_csv("teams.csv", team_cols,
              [[r[c] for c in team_cols] for r in read_csv("Teams.csv")])

    export_franchises()

    write_csv("awards.csv", ["playerID", "awardID", "yearID", "lgID"],
              [[r["playerID"], r["awardID"], r["yearID"], r["lgID"]]
               for r in read_csv("AwardsPlayers.csv")])

    # one row per game, not per season: 1959-1962 had two All-Star games
    write_csv("allstar.csv", ["playerID", "yearID"],
              [[r["playerID"], r["yearID"]] for r in read_csv("AllstarFull.csv")])

    write_csv("hof.csv", ["playerID", "yearid", "votedBy", "category"],
              [[r["playerID"], r["yearid"], r["votedBy"], r["category"]]
               for r in read_csv("HallOfFame.csv") if r["inducted"] == "Y"])

    sp_cols = ["yearID", "round", "teamIDwinner", "lgIDwinner", "teamIDloser",
               "lgIDloser", "wins", "losses", "ties"]
    write_csv("seriespost.csv", sp_cols,
              [[r[c] for c in sp_cols] for r in read_csv("SeriesPost.csv")])

DATA_FILES = ["people.csv", "batting.csv", "pitching.csv", "fielding.csv",
              "teams.csv", "awards.csv", "allstar.csv", "hof.csv",
              "seriespost.csv", "franchises.csv", "franchise_eras.csv"]

# ------------------------------------------------------------- icon (pure py)

def make_icon(size, path):
    """Draw a baseball on a green field; write as PNG with no image libs."""
    cx = cy = size / 2.0
    ball_r = size * 0.36
    stitch_r = ball_r * 0.95
    stitch_off = ball_r * 1.35          # stitch-arc circle centers, off-ball
    stitch_w = max(2.0, size * 0.02)
    bg = (11, 61, 46)                   # --green
    white = (250, 247, 240)
    red = (184, 68, 44)                 # --accent

    rows = []
    for y in range(size):
        row = bytearray([0])            # PNG filter byte
        for x in range(size):
            dx, dy = x - cx, y - cy
            d = (dx * dx + dy * dy) ** 0.5
            color = bg
            if d <= ball_r:
                color = white
                for sx in (cx - stitch_off, cx + stitch_off):
                    sd = ((x - sx) ** 2 + dy * dy) ** 0.5
                    if abs(sd - stitch_r) < stitch_w and d < ball_r - 1:
                        color = red
                if ball_r - 1.5 < d:    # soft dark edge
                    color = tuple((c + bg[i]) // 2 for i, c in enumerate(color))
            row += bytes(color)
        rows.append(bytes(row))

    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", raw))
        f.write(chunk(b"IEND", b""))

# ------------------------------------------------------------- site assembly

def build_site():
    print("Assembling site...")
    shutil.copy(os.path.join(BASE, "static", "style.css"), DOCS)
    shutil.copy(os.path.join(BASE, "static", "app.js"), DOCS)
    shutil.copy(os.path.join(BASE, "static", "api-local.js"), DOCS)

    # Pages runs the branch through Jekyll unless this file is present, and
    # Jekyll drops anything whose name starts with _ or . from the output.
    # Nothing here is named that way today; this keeps it that way if the
    # exports ever grow a directory that is.
    open(os.path.join(DOCS, ".nojekyll"), "w").close()

    with open(os.path.join(BASE, "static", "index.html"), encoding="utf-8") as f:
        html = f.read()
    html = html.replace(
        '<link rel="stylesheet" href="style.css">',
        '<link rel="stylesheet" href="style.css">\n'
        '<link rel="manifest" href="manifest.json">\n'
        '<link rel="apple-touch-icon" href="icon-180.png">')
    html = html.replace(
        '<script src="app.js"></script>',
        '<script src="api-local.js"></script>\n'
        '<script src="app.js"></script>\n'
        '<script>\n'
        "if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');\n"
        '</script>')
    with open(os.path.join(DOCS, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)

    make_icon(180, os.path.join(DOCS, "icon-180.png"))
    make_icon(512, os.path.join(DOCS, "icon-512.png"))

    manifest = {
        "name": "Baseball Records",
        "short_name": "Baseball",
        "start_url": ".",
        "display": "standalone",
        "background_color": "#faf7f0",
        "theme_color": "#0b3d2e",
        "icons": [
            {"src": "icon-180.png", "sizes": "180x180", "type": "image/png"},
            {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
        ],
    }
    with open(os.path.join(DOCS, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    # version = hash of the data + code, so the service worker refreshes caches
    h = hashlib.sha256()
    for name in DATA_FILES:
        with open(os.path.join(DATA_OUT, name), "rb") as f:
            h.update(f.read())
    for name in ["index.html", "style.css", "app.js", "api-local.js"]:
        with open(os.path.join(DOCS, name), "rb") as f:
            h.update(f.read())
    version = h.hexdigest()[:12]

    assets = (["./", "index.html", "style.css", "app.js", "api-local.js",
               "manifest.json", "icon-180.png", "icon-512.png"]
              + ["data/" + n for n in DATA_FILES])
    sw = """/* generated by build_site.py */
const CACHE = 'baseball-records-%s';
const ASSETS = %s;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) =>
      hit || fetch(e.request))
  );
});
""" % (version, json.dumps(assets))
    with open(os.path.join(DOCS, "sw.js"), "w") as f:
        f.write(sw)
    print("Site version: %s" % version)


def main():
    os.makedirs(DOCS, exist_ok=True)
    export_data()
    build_site()
    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(DOCS) for f in fs)
    print("Done. docs/ is %.1f MB — serve locally with:" % (total / 1e6))
    print("  python3 -m http.server -d docs 8001")


if __name__ == "__main__":
    main()
