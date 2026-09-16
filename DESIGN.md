# Design decisions

Settled decisions and the alternatives that lost, so they are not re-argued —
the same purpose as `baseball-games/DESIGN.md`, for this repository's choices.

## Two apps, not one · proposed 2026-08-25

**Status: proposed, not settled.**

Whether this app and `baseball-games` should be combined into one was asked and
analysed on 2026-08-25. The recommendation is no: keep two apps and cross-link
them on `People.retroID`.

The argument is written once, in **`baseball-games/DESIGN.md`**, rather than
copied here where the two would drift. In short: what the two share is
architecture rather than code, and ~74 lines of Favorites is the only real
duplication; this app's `docs/` is 18 MB and an offline PWA where that one's is
632 MB against a 1 GB Pages cap, so they do not fit in one budget; and the two
answer different questions off differently-licensed sources, on separate
release cadences.

This repository's share of the followup, if it goes ahead: export `retroID` on
the player payload — already present in `data/csv/People.csv` as column 25, and
populated for 23,373 of 24,270 people — and render a link out to that app's
player page. Mind the leading slash: it routes `#/player/<retroID>`, this app
routes `#player/<playerID>`.

Expect the two sides to report different career totals, and say so where the
link appears. Retrosheet sums its own box scores and publishes no official
totals; the disagreement is a property of the sources, not a bug in either app.

## WAR comes from Baseball-Reference · settled 2026-09-16

Lahman has no adjusted metric of any kind — no WAR, no park factor, no OPS+.
`war_daily_bat.txt` and `war_daily_pitch.txt` fill that gap and need no
crosswalk work: they are keyed on `player_ID`, which *is* the `bbrefID` already
in `People.csv`.

### It is imported, not derived, and that is a real change

Every other statistic in this app is a SQL expression over the committed CSVs —
see `batting_expr` in `app.py`. WAR is someone else's opinion, computed by a
methodology that B-Ref revises retroactively, so a later re-fetch can move
Ruth's career total with nothing in this repository having changed. That is
accepted deliberately, because no amount of arithmetic over Lahman produces a
park- and league-adjusted number, and it is the reason the files are fetched by
an explicit command rather than silently on a timer.

### One WAR per row, not one per player

Pitchers appear in *both* files: 39,889 pitcher-seasons carry a value on the
mound and another at the plate, and B-Ref's headline career figure is the sum
(Ruth 162.3 + 20.4 = 182.6, which the two files reproduce exactly).

The app shows each on its own table's rows — batting WAR on the batting line,
pitching WAR on the pitching line — and prints no combined total. Only **81
players of 23,798 (0.34%)** have both sides reach ±5, and most of those are
pitchers who could hit a little rather than two-way players. The career-totals
rows already give both halves, so a reader who wants Ruth's 182.6 adds them;
inventing a third number would put a figure on the page that disagrees with
each table above it.

### The team codes are learned, not written down

The two sources spell clubs differently and systematically: Lahman uses
Retrosheet-style codes (`CHN`, `CHA`, `SLN`, `NYA`) where B-Ref uses colloquial
ones (`CHC`, `CHW`, `STL`, `NYY`).

`link_war.py` learns the mapping from the data instead. 91.8% of player-seasons
have exactly one row on each side, where the pairing is certain whatever the
clubs are called; those vote on what each B-Ref code means in each year, and
the rest are resolved with the result — checked against the clubs Lahman agrees
he played for, so a learned code cannot put a traded man on the wrong half of
his season.

**Rejected:**

- **Joining on the team code as written.** Matches 57.6%, and the other 42%
  lose their WAR silently with nothing on the page to say why.
- **Joining on `stint_ID`.** 84.7% — the two number stints differently.
- **A hand-maintained crosswalk.** It would need an edit every time either
  source adds a club, and would fail quietly when it did not get one.

Result: 98.7% of batting rows and 98.8% of pitching rows linked. What is left
keeps a NULL `teamID` and shows no WAR, which is the honest answer to "we could
not identify this row".

### The two sources run on different clocks

Lahman ships once a year. These are `war_daily` and are rebuilt continuously,
so B-Ref is nearly always a season ahead — it carried 2026 while Lahman still
ended at 2025.

Alone that is harmless: a WAR row for a season Lahman has never heard of joins
to nothing. It stops being harmless when the two are fetched months apart, at
which point a complete season of batting lines pairs with a partial season's
WAR. **That does not error and does not look wrong — the column just reads
low**, which makes it exactly the kind of bug this repository is otherwise
careful about.

Two independent guards:

- `update_data.py` fetches Lahman and the WAR files in the same run, so they
  are always a consistent pair rather than whatever happened to be on disk.
- `build_db.py` drops WAR rows past `MAX(yearID)` in `Batting`, so an
  incomplete tail cannot attach itself to a complete season even if someone
  runs the steps out of order. It removed 819 batting and 978 pitching rows of
  in-progress 2026 on the first build.

A B-Ref failure is a warning, not an exit: WAR is an addition to Lahman, not a
precondition for it, and a new season that lands without it should still
install. Same shape as `baseball-sim`, where Retrosheet is optional and the
pull "says so and carries on".

### The files are not in `data/csv/`

`update_data.py` renames that whole directory aside on a refresh and moves the
newly-unzipped Lahman folder into its place, so anything of ours in there is
destroyed once a year. They live in `data/war/`, which `build_db.py` scans as a
second source.

Only the columns actually read are kept — 51 MB of source becomes 7 MB on disk.
The `runs_*` components behind WAR (batting, baserunning, fielding, positional,
replacement) are deliberately not kept: they are a different feature, and
adding them is one line in `KEEP`.

### The blank stays blank, and About says why · settled 2026-09-16

B-Ref covers 14 leagues including all seven Negro major leagues, but **not** the
five barnstorming pseudo-leagues — `IND`, `EAS`, `WES`, `NAC`, `INT`. That is
1,870 position-player seasons, of which 74 match: the 876 players README.md
defends including on the grounds that segregation is why they have no league to
be listed under.

So the WAR column is blank for exactly the players this app went out of its way
not to drop, and an empty cell would otherwise read as *wasn't good enough*.

The cell stays blank — no dash, no asterisk, no placeholder figure — and the
About page carries the reason, which is where this app already puts what the
source can and cannot say. The wording gives the mechanism rather than an
apology: WAR is measured against a league's run environment and the replacement
level drawn from it, and a club that played outside a league structure has no
such baseline. **A blank there means no figure has been published, not a low
one.**

**Rejected:** a per-cell footnote marker, which puts an apology on 1,870 rows to
explain something that is true of a whole category of club; and any imputed or
estimated value, which would be this app inventing a number that B-Ref
deliberately does not publish.
