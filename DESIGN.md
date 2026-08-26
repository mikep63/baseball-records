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
