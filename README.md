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

- **Players** — search any of 24,000+ players by name, ranked by how well the
  name matches, then Hall of Fame membership, then playing time; see full career
  year-by-year batting and pitching with career totals, career fielding by
  position, plus awards, All-Star selections, and Hall of Fame status.
  Players who moved around the diamond get a position arc — Ruth reads
  *P 1914–1917 → OF 1918–1935*, Rose *2B → OF → 3B → 1B*.
- **Seasons** *(the landing page)* — pick a year (1871–2025) for a dashboard of every league's
  Triple Crown leaders, then the standings grouped by league/division; click
  a team for its full roster, or a stat for the full leaderboard.
- **Franchises** — all 203 franchises by their current name, with the cities
  they played in before (Dodgers *formerly Brooklyn*, Nationals *formerly
  Montreal*). Open one for its location timeline, every name it has ever
  had, and a season-by-season record.
- **Leaders** — one tab with four spans, top 10/25/50 for any stat:
  *Single Year* (1927 home runs), *Season* (the best individual seasons —
  Bonds' 73 in 2001), *Multi-Year* (totals over a span, e.g. home runs
  1990–1999), and *Career*.

  *Season* picks its span by era rather than year pair — **All time**,
  **Modern 1901–**, **Divisional 1969–**, or Custom — because the answer
  changes completely with the era, and that is the point. All-time strikeouts
  gives Matt Kilroy's 513 in 1886, when pitchers threw 500 innings; Divisional
  gives Nolan Ryan's 383. All-time batting average gives an 1871 oddity;
  Divisional gives Tony Gwynn's .394.

### Stats available

- Batting: G, AB, R, H, 2B, 3B, HR, RBI, SB, BB, SO, TB, AVG, OBP, SLG, OPS
- Pitching: W, L, G, GS, CG, SHO, SV, IP, SO, BB, ERA, WHIP

### How leaderboards are scoped

Leaderboards rank **every league in the database**, with no whitelist. All 19
are major-league caliber by SABR's own reckoning (`data/readme2025.txt` §1.1):
the National Association, American Association, Union Association, Players
League, Federal League, AL and NL, the seven Negro major leagues, and the
barnstorming clubs filed under the pseudo-leagues `IND`, `EAS`, `WES`, `NAC`
and `INT`. Of those last, SABR writes that they were

> selected as major league caliber in light of the economic and social
> conditions that forced them to play outside a typical league structure.

Those are the Cuban X Giants, Philadelphia Giants, Brooklyn Royal Giants and
their peers — 876 players. Segregation is why they have no league to be listed
under, so filtering them out would drop them for the shape of their records
rather than the substance.

Sample size is a separate question, answered by the schedule floor below.

Rate stats then apply the official playing-time qualifier: **3.1 PA (or 1 IP)
per game the player's own league scheduled**, counted as games that were
*decided* rather than games played — `Teams.G` includes ties, which were
replayed rather than settled before lights and belong to nobody's schedule.
The 1989 Pirates show `G`=164 against a 162-game season and the 1904 Athletics
`G`=162 against 154; taking `G` raises the bar by up to eight games, enough to
have cost Billy Goodman the 1950 batting title and Rod Carew the 1969. It is per league, not per game the longest
league that year played, which would hold a short-schedule league to someone
else's bar. That distinction matters twice over: the Negro Leagues played
~80-game seasons against the AL's 157, and in strike-shortened 1994 it decides
the AL ERA title. A player traded across leagues mid-season is held to the
longest schedule he appeared in.

The bar is floored at a **40-game schedule**. Some clubs have only a handful
of recorded games, where 3.1 per game is a bar of three plate appearances and
a 1-for-1 afternoon takes the batting crown; the floor also catches stub
seasons in the established leagues, like the ECL folding seven games into
1928. It filters on sample size rather than on which league a player was
allowed to play in.

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
| `build_site.py` | builds the serverless GitHub Pages / PWA site into `docs/`,
  stamping the build id into `app.js` so About can report it |
| `docs/` | static build: frontend + compact data + service worker (generated) |
| `app.py` | JSON API + static file server (stdlib `http.server`) |
| `static/` | single-page frontend (vanilla HTML/CSS/JS) |

API endpoints: `/api/meta`, `/api/search?q=`, `/api/player/<id>`,
`/api/teams?year=`, `/api/roster?year=&team=`, `/api/postseason?year=`,
`/api/season_leaders?year=`, `/api/franchises`, `/api/franchise/<franchID>`,
`/api/leaders?year=&stat=&cat=`, `/api/leaders_range?start=&end=&stat=&cat=`,
`/api/best_seasons?start=&end=&stat=&cat=`.

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

## Future work

Low priority, and measured rather than guessed — the savings are small enough
that none of this is urgent.

**Trim unused indexes** (~1.4 MB, faster rebuilds). `build_db.py` indexes
`Salaries`, `PitchingPost` and `FieldingPost`, which nothing queries. Costs
nothing to drop; `lahman.sqlite` is gitignored, so this buys build time and
local disk, not repo size.

**Precompute the fielding export** (1.97 MB raw, 0.70 MB gzipped — a 13%
smaller first install). `fielding.csv` is 5.85 MB of raw player/season/team/
position rows feeding just two views, which collapse very differently:

| | Rows | Size | Gzipped |
|---|---|---|---|
| today | 174,332 | 5.85 MB | 1.57 MB |
| career totals by position | 42,200 | 1.17 MB | 0.39 MB |
| primary position per season | 127,005 | 2.71 MB | 0.48 MB |
| replacement total | | 3.88 MB | 0.87 MB |

The career half is the win: the player page shows only career fielding by
position, so 174k rows render a 42k-row aggregate, a 5:1 collapse. The roster
half is not, because a batter's position needs player × season × team
granularity and cannot aggregate away — most of that 2.71 MB is `playerID`
strings.

Nothing displays season-by-season fielding today, so precomputing removes no
feature, but it would foreclose adding one without a re-export. The cleaner
version of this change is to precompute the career file and reconsider whether
the roster needs a position column at all — dropping that saves the whole
5.85 MB rather than a third of it.

**Don't bother dropping unused tables from `data/csv`.** It saves 6.2 MB of
repo and nothing for users, since `build_site.py` already exports only what it
needs. It would also mean maintaining an allowlist in `update_data.py` that
fails silently when it drifts, and would foreclose the features below.

### Room to grow

Tables the app doesn't read yet: `Managers` and `AwardsManagers` (an entire
category of person, absent), `AwardsSharePlayers` (vote shares — "finished 2nd
in MVP voting" is data already on disk), `PitchingPost` and `FieldingPost`
(`BattingPost` is used, its siblings are not), `CollegePlaying` + `Schools`,
`HomeGames`, and `FieldingOF`/`FieldingOFsplit` (the LF/CF/RF breakdown behind
the generic OF position).

## Data & license

Player and team data from the
[Lahman Baseball Database](https://sabr.org/lahman-database/), copyright
© 1996–2025 **SABR** via generous donation from Sean Lahman, used under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).

The exports in `docs/data/` are **modified** derivatives — column subsets, a
derived `careerG` column, the reconstructed franchise tables, and inducted
Hall of Famers only — and are shared under that same licence. No statistic is
altered. See [LICENSE](LICENSE) for the full breakdown, and the app's About
page for acknowledgements of the researchers behind the database.

The code in this repository is MIT licensed; the data is not. Nothing here is
affiliated with or endorsed by SABR, MLB, or any club.
