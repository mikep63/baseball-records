#!/usr/bin/env python3
"""Franchise history derived from Teams + TeamsFranchises.

Lahman has no franchise-level history: TeamsFranchises gives one flat name
per franchise, and every rename and relocation is buried in the per-season
Teams.name string. This module reconstructs both, so a franchise can be
listed by what it is called now and what it used to be called.

Shared by app.py (reads sqlite) and build_site.py (reads the CSVs); both
hand it the same row dicts.
"""

# ------------------------------------------------------------------ locations
# A franchise brands itself with a place, but not always a city: the Twins
# are "Minnesota", the Rays are "Tampa Bay". The location is whatever place
# prefixes the name, so the vocabulary needs regions as well as cities.
STATES = [
    "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
    "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
    "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana",
    "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota",
    "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
    "New Hampshire", "New Jersey", "New Mexico", "New York",
    "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon",
    "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota",
    "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington",
    "West Virginia", "Wisconsin", "Wyoming",
]

# Places that front a team name but are neither a park city nor a state.
EXTRA_PLACES = [
    "Tampa Bay", "Homestead", "Hilldale", "West Baden", "Harlem",
    "Elizabeth", "Toledo", "Cuban",
]

# Same place, spelled differently across eras — folding these together keeps
# a spelling change from reading as a move. (Pittsburgh dropped the 'h'
# from 1891.)
PLACE_ALIASES = {
    "Pittsburg": "Pittsburgh",
}

# Clubs that never had a home city: barnstorming and touring outfits. Their
# name is the whole identity, so they get no location at all.
PLACELESS = {
    "Cuban", "All Cubans", "Stars of Cuba", "Page Fence Giants",
}


def _split_place(name, vocab):
    """Longest place name that prefixes `name`, else None.

    Hyphenated pairs ("Cincinnati-Indianapolis Clowns") are split first so
    both halves resolve; the pair is kept as one location, since the club
    really did split its home games between the two.
    """
    head = name.split(" ")[0]
    if "-" in head or "/" in head:
        sep = "-" if "-" in head else "/"
        parts = [PLACE_ALIASES.get(p, p) for p in head.split(sep)]
        if all(p in vocab for p in parts):
            return "-".join(parts)
    for place in vocab:
        if name == place or name.startswith(place + " "):
            return PLACE_ALIASES.get(place, place)
    return None


def build_vocab(park_rows):
    """Place vocabulary, longest first so 'Tampa Bay' beats 'Tampa'."""
    places = set(STATES) | set(EXTRA_PLACES) | set(PLACE_ALIASES)
    for p in park_rows:
        city = (p.get("city") or "").strip()
        if city:
            places.add(city)
    return sorted(places, key=len, reverse=True)


def location_of(name, vocab):
    """The place a team brands itself with, or None if it has none."""
    name = (name or "").strip()
    if name in PLACELESS:
        return None
    place = _split_place(name, vocab)
    if place is None:
        return None
    # "Cuban Stars East" etc. are touring clubs, not a club from Cuba
    if place == "Cuban":
        return None
    return place


# ---------------------------------------------------------------------- runs
def _runs(items):
    """Collapse [(year, value), ...] into runs, breaking only when it changes.

    Lahman's nicknames are not strictly sequential — Brooklyn alternated
    between Superbas, Dodgers and Robins for years — so grouping by name
    and taking MIN/MAX(year) yields overlapping nonsense. Runs keep each
    stretch separate and in order.

    A gap in seasons does not start a new run. Negro League clubs sat out
    whole years, and a dormant season is not a rename or a move; breaking
    on it would list the same city three times in a row.
    """
    out = []
    for year, value in items:
        if out and out[-1]["value"] == value:
            out[-1]["hi"] = year
        else:
            out.append({"value": value, "lo": year, "hi": year})
    return out


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return 0


# --------------------------------------------------------------------- parks
def park_lookup(park_rows):
    """Park name -> row, including the aliases.

    A stadium keeps its identity through a rename, and Lahman records the
    season under whatever it was called at the time: the Marlins' Joe Robbie,
    Pro Player, Dolphin and Sun Life Stadium are one building. Matching the
    alias column as well as the name takes the join from 67% of team-seasons
    to 82%.
    """
    look = {}
    for p in park_rows:
        name = (p.get("parkname") or "").strip()
        if name:
            look.setdefault(name, p)
        for alias in (p.get("parkalias") or "").split(";"):
            alias = alias.strip()
            if alias:
                look.setdefault(alias, p)
    return look


def park_runs(team_rows, look):
    """Consecutive seasons in one ballpark, oldest first.

    Seasons with no park on record are skipped rather than shown as a blank
    row; 24 team-seasons have none, nearly all of them touring clubs with no
    home ground to name.
    """
    out = []
    for t in sorted(team_rows, key=lambda r: _int(r["yearID"])):
        name = (t.get("park") or "").strip()
        year = _int(t["yearID"])
        if out and out[-1]["park"] == name:
            out[-1]["lastYear"] = year
            continue
        info = look.get(name)
        out.append({
            "park": name,
            "city": (info.get("city") or "").strip() if info else "",
            "state": (info.get("state") or "").strip() if info else "",
            "firstYear": year, "lastYear": year,
        })
    return [r for r in out if r["park"]]


# ------------------------------------------------------------------- builder
def build(team_rows, franchise_rows, park_rows):
    """One record per franchise, newest name first, with its full history.

    team_rows need franchID, yearID, name, teamID, lgID and (optionally)
    W, L, WSWin, LgWin. Rows may arrive in any order.
    """
    vocab = build_vocab(park_rows)
    parks = park_lookup(park_rows)
    meta = {f["franchID"]: f for f in franchise_rows}

    by_franchise = {}
    for t in team_rows:
        fid = (t.get("franchID") or "").strip()
        if fid:
            by_franchise.setdefault(fid, []).append(t)

    out = []
    for fid, rows in by_franchise.items():
        rows.sort(key=lambda r: (_int(r["yearID"]), r.get("teamID") or ""))
        seasons = sorted({_int(r["yearID"]) for r in rows})

        name_runs = _runs([(_int(r["yearID"]), (r["name"] or "").strip())
                           for r in rows])
        eras = []
        for run in name_runs:
            span = [r for r in rows
                    if run["lo"] <= _int(r["yearID"]) <= run["hi"]
                    and (r["name"] or "").strip() == run["value"]]
            eras.append({
                "name": run["value"],
                "firstYear": run["lo"],
                "lastYear": run["hi"],
                "teamID": span[-1].get("teamID") or "",
                "lgID": span[-1].get("lgID") or "",
            })

        # An unknown location carries the previous one forward rather than
        # breaking the run — a name we cannot parse is missing data, not a
        # move. (The 2025 Athletics dropped their city from the name.)
        loc_items, carried = [], None
        for r in rows:
            loc = location_of(r["name"], vocab)
            if loc is None:
                loc = carried
            carried = loc
            loc_items.append((_int(r["yearID"]), loc))
        location_runs = [r for r in _runs(loc_items) if r["value"] is not None]
        locations = [{"location": r["value"], "firstYear": r["lo"],
                      "lastYear": r["hi"]} for r in location_runs]

        info = meta.get(fid, {})
        out.append({
            "franchID": fid,
            # the current name, not TeamsFranchises.franchName, which goes
            # stale (it still says Cleveland Indians) and is not unique
            "name": eras[-1]["name"],
            "franchName": (info.get("franchName") or "").strip(),
            "active": (info.get("active") or "").strip(),
            "firstYear": seasons[0],
            "lastYear": seasons[-1],
            "seasons": len(seasons),
            "W": sum(_int(r.get("W")) for r in rows),
            "L": sum(_int(r.get("L")) for r in rows),
            "pennants": sum(1 for r in rows if (r.get("LgWin") or "") == "Y"),
            "titles": sum(1 for r in rows if (r.get("WSWin") or "") == "Y"),
            "teamID": eras[-1]["teamID"],
            "lgID": eras[-1]["lgID"],
            "locations": locations,
            "eras": eras,
            "parks": park_runs(rows, parks),
        })

    out.sort(key=lambda f: f["name"])
    return out


def summary(f):
    """The listing row: current name plus the cities it played in before."""
    former = [l["location"] for l in f["locations"][:-1]]
    return {
        "franchID": f["franchID"], "name": f["name"], "active": f["active"],
        "firstYear": f["firstYear"], "lastYear": f["lastYear"],
        "seasons": f["seasons"], "W": f["W"], "L": f["L"],
        "pennants": f["pennants"], "titles": f["titles"],
        "teamID": f["teamID"], "lgID": f["lgID"],
        "former": former,
        "nameCount": len({e["name"] for e in f["eras"]}),
    }
