# Baseball Records

A zero-dependency local web app over the **Lahman Baseball Database** (1871–2025).
Runs on the Python standard library only — no pip installs needed.

## Quick start

```bash
python3 app.py         # serves http://127.0.0.1:8000
```

Open http://127.0.0.1:8000 in your browser. On first run (or whenever the
CSVs change) the app builds `lahman.sqlite` automatically (~30 sec).

## GitHub Pages / no-server mode

The `docs/` folder is a completely self-contained static build of the same
app — all querying runs in the browser (no Python needed). To host it free
on GitHub Pages:

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Deploy from a branch** → branch `main`,
   folder `/docs`.
3. Your app is live at `https://<user>.github.io/baseball-records/` on any
   device, anywhere.

It's also an offline-capable PWA: open it once on your iPhone/iPad, use
Safari's *Add to Home Screen*, and it works with no connection at all
(a service worker caches the app and data on-device, ~5 MB download).

Rebuild it after any data or frontend change with `python3 build_site.py`
(`update_data.py` does this automatically). To preview locally:

```bash
python3 -m http.server -d docs 8001
```

## Yearly data updates

When a new season's Lahman release is out:

```bash
python3 update_data.py
```

That downloads the latest CSVs, sanity-checks them (refuses truncated data or
a year downgrade), swaps them into `data/csv/`, and rebuilds the database.
A running `app.py` picks up the new database automatically — connections are
per-request, so no restart is needed.

Options:

```bash
python3 update_data.py --zip lahman.zip   # use a manually downloaded zip
python3 update_data.py --url <url>        # pull from a different source
python3 update_data.py --keep-db          # swap CSVs only; app rebuilds on next start
```

The script finds the CSV folder inside the zip wherever it lives, so it keeps
working when the source renames its folder each year
(`lahman_1871-2025_csv` → `lahman_1871-2026_csv`, …).

### Use it from your iPhone / iPad

```bash
python3 app.py --lan
```

It prints a `http://<your-Mac-IP>:8000` URL — open that on any device on the
same Wi-Fi. The UI is fully responsive (phone, tablet, desktop), and you can
use Safari's *Add to Home Screen* to run it like an app.

## Features

- **Players** — search any of 24,000+ players by name; see full career
  year-by-year batting, pitching, and fielding with career totals, plus
  awards, All-Star selections, and Hall of Fame status.
- **Teams** — pick a year (1871–2025), see every team's record grouped by
  league/division; click a team for its full roster with high-level stats.
- **Franchises** — all 203 franchises by their current name, with the cities
  they played in before (Dodgers *formerly Brooklyn*, Nationals *formerly
  Montreal*). Open one for its location timeline, every name it has ever
  had, and a season-by-season record.
- **Season Leaders** — pick a year, category (batting/pitching), and stat;
  top 10/25/50.
- **Range Leaders** — pick a start year, end year, and stat (e.g. home runs
  1990–1999) for the top 10/25/50 aggregated over the span.

### Stats available

- Batting: G, AB, R, H, 2B, 3B, HR, RBI, SB, BB, SO, TB, AVG, OBP, SLG, OPS
- Pitching: W, L, G, GS, CG, SHO, SV, IP, SO, BB, ERA, WHIP

### How leaderboards are scoped

Leaderboards rank **major-league play only**, using the list MLB itself
recognises: NL, AA, UA, PL, AL, FL, plus the seven Negro major leagues
recognised in 2020 (NNL, ECL, ANL, EWL, NSL, NN2, NAL). Lahman also carries
independent and touring ball — a handful of recorded games against whoever
turned up — which is not a season anyone led. The National Association
(1871–75) is excluded for the same reason MLB excludes it, so those seasons
are browsable but have no leaderboard and are left out of the year pickers.

Rate stats then apply the official playing-time qualifier: **3.1 PA (or 1 IP)
per game the player's own league played** — not per game the longest league
in that year played, which would hold a short-schedule league to someone
else's bar. That distinction matters twice over: the Negro Leagues played
~80-game seasons against the AL's 157, and in strike-shortened 1994 it decides
the AL ERA title. The bar is floored at a 40-game schedule, since even a
recognised league can post a stub season (the ECL folded seven games into
1928). A player traded across leagues mid-season is held to the longest
schedule he appeared in.

Multi-season and career leaderboards use a heuristic of our own rather than
any official rule: 400 PA (or 130 IP) per year in the span, capped at
3,000 PA / 1,000 IP.

## Layout

| Path | Purpose |
|---|---|
| `data/csv/` | Lahman source CSVs (checked in) |
| `update_data.py` | fetches the latest Lahman release and rebuilds the DB |
| `build_db.py` | loads CSVs into `lahman.sqlite` with indexes |
| `franchises.py` | reconstructs franchise renames/relocations from `Teams` |
| `build_site.py` | builds the serverless GitHub Pages / PWA site into `docs/` |
| `docs/` | static build: frontend + compact data + service worker (generated) |
| `app.py` | JSON API + static file server (stdlib `http.server`) |
| `static/` | single-page frontend (vanilla HTML/CSS/JS) |

API endpoints: `/api/meta`, `/api/search?q=`, `/api/player/<id>`,
`/api/teams?year=`, `/api/roster?year=&team=`, `/api/franchises`,
`/api/franchise/<franchID>`,
`/api/leaders?year=&stat=&cat=`, `/api/leaders_range?start=&end=&stat=&cat=`.

### Franchise history

Lahman stores no franchise history: `TeamsFranchises` holds one flat name per
franchise, and every rename and move is buried in the per-season `Teams.name`
string. `franchises.py` reconstructs both, which takes three fixes:

- **Names come from the latest season, not `franchName`**, which goes stale
  (it still says *Cleveland Indians*), hides relocation (`WSN` reads
  *Washington Nationals*, erasing the Expos), and is not unique — five
  different franchises are named *Washington Nationals*.
- **Eras are contiguous runs, not `GROUP BY name`.** Early nicknames were
  informal and alternate year to year (Brooklyn ran Superbas → Dodgers →
  Superbas → Robins → Dodgers), so min/max per name yields overlapping spans.
- **Location comes from the name prefix, not the ballpark.** Park cities look
  tempting but flip on temporary venues, inventing moves the franchise never
  made. The prefix is matched against park cities plus states and regions, so
  *Minnesota* and *Tampa Bay* resolve; an unparseable name inherits the
  previous location rather than faking a move.

## Data & license

Player and team data from the [Lahman Baseball Database](http://seanlahman.com)
/ Baseball Databank, used under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
The database also contains postseason pitching and fielding, salaries,
managers, award vote shares, colleges, and more (see `data/csv/`) — plenty of
room to grow.
