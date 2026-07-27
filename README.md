# Baseball Records

A zero-dependency local web app over the **Lahman Baseball Database** (1871–2025).
Runs on the Python standard library only — no pip installs needed.

## Quick start

```bash
python3 app.py         # serves http://127.0.0.1:8000
```

Open http://127.0.0.1:8000 in your browser. On first run (or whenever the
CSVs change) the app builds `lahman.sqlite` automatically (~30 sec).

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
- **Season Leaders** — pick a year, category (batting/pitching), and stat;
  top 10/25/50.
- **Range Leaders** — pick a start year, end year, and stat (e.g. home runs
  1990–1999) for the top 10/25/50 aggregated over the span.

### Stats available

- Batting: G, AB, R, H, 2B, 3B, HR, RBI, SB, BB, SO, TB, AVG, OBP, SLG, OPS
- Pitching: W, L, G, GS, CG, SHO, SV, IP, SO, BB, ERA, WHIP

Rate-stat leaderboards apply playing-time qualifiers: single seasons use
≈3.1 PA (or 1 IP) per team game, mirroring the official rule; year ranges
require 400 PA (or 130 IP) per year in the span, capped at 3,000 PA / 1,000 IP.

## Layout

| Path | Purpose |
|---|---|
| `data/csv/` | Lahman source CSVs (checked in) |
| `update_data.py` | fetches the latest Lahman release and rebuilds the DB |
| `build_db.py` | loads CSVs into `lahman.sqlite` with indexes |
| `app.py` | JSON API + static file server (stdlib `http.server`) |
| `static/` | single-page frontend (vanilla HTML/CSS/JS) |

API endpoints: `/api/meta`, `/api/search?q=`, `/api/player/<id>`,
`/api/teams?year=`, `/api/roster?year=&team=`,
`/api/leaders?year=&stat=&cat=`, `/api/leaders_range?start=&end=&stat=&cat=`.

## Data & license

Player and team data from the [Lahman Baseball Database](http://seanlahman.com)
/ Baseball Databank, used under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
The database also contains postseason stats, salaries, managers, parks,
colleges, and more (see `data/csv/`) — plenty of room to grow.
