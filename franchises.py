#!/usr/bin/env python3
"""Franchise history derived from Teams + TeamsFranchises.

Lahman has no franchise-level history: TeamsFranchises gives one flat name
per franchise, and every rename and relocation is buried in the per-season
Teams.name string. This module reconstructs both, so a franchise can be
listed by what it is called now and what it used to be called.

Shared by app.py (reads sqlite) and build_site.py (reads the CSVs); both
hand it the same row dicts.
"""
import re

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

    Every hyphen is tried, not just one inside the first word, because either
    half may be a multi-word city: the St. Louis-New Orleans Stars name two
    cities across four words, and reading only "St." finds neither.
    """
    for i, ch in enumerate(name):
        if ch not in "-/":
            continue
        left = name[:i].strip()
        left = PLACE_ALIASES.get(left, left)
        if left not in vocab:
            continue
        right = _split_place(name[i + 1:].strip(), vocab)
        if right:
            return left + "-" + right
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
# Where Lahman contradicts itself: Teams.park spells a ground one way and
# Parks.parkname another, so the join finds nothing. Keyed by the Teams
# spelling, valued by the Parks one. Each entry corrects a specific
# disagreement inside the source; none invents a park Lahman does not have.
#
# Sutter Health Park is the Athletics' temporary home from 2025 while the Las
# Vegas ground is built. Parks files it as "Sutter Health Field"; Teams calls
# it "Sutter Health Park", which is the name the ballpark actually carries.
PARK_NAME_FIXES = {
    "Sutter Health Park": "Sutter Health Field",
}


def park_lookup(park_rows):
    """Park name -> every building it could mean, likeliest first.

    A stadium keeps its identity through a rename, and Lahman records the
    season under whatever it was called at the time: the Marlins' Joe Robbie,
    Pro Player, Dolphin and Sun Life Stadium are one building. Matching the
    alias column as well as the name takes the join from 67% of team-seasons
    to 82%.

    A name is not an identifier, though. Fifteen names belong to more than one
    ballpark — three Columbia Parks, two Wrigley Fields, five Athletic Parks —
    and Parks has no team column to settle which is meant, so the candidates
    are all kept and resolve_parks picks between them per season. Names come
    before aliases: a park called X outranks one merely also called X.
    """
    look = {}
    for p in park_rows:
        name = (p.get("parkname") or "").strip()
        if name:
            look.setdefault(name, []).append(p)
    for p in park_rows:
        for alias in (p.get("parkalias") or "").split(";"):
            alias = alias.strip()
            if not alias:
                continue
            candidates = look.setdefault(alias, [])
            # Identity, not a key: these rows are dicts from the CSV in one
            # caller and sqlite3.Row objects from lahman.sqlite in another.
            if all(c is not p for c in candidates):
                candidates.append(p)
    for wrong, right in PARK_NAME_FIXES.items():
        if wrong not in look and right in look:
            look[wrong] = look[right]
    return look


def _city(info):
    return (info.get("city") or "").strip() if info else ""


def resolve_parks(seasons, look):
    """Which building each season's park name refers to.

    Unambiguous names settle themselves. The rest are decided on the evidence
    around them, in this order:

    Where the club played either side of the season in question. A ground in
    1911 is in the same city as the ground in 1910 unless the club moved, and
    when it did move the seasons on the far side say where to. This is what
    rescues Cleveland's League Park II from Cincinnati's, 37 seasons of it.

    Then the club's own name, which usually carries its city — though not for
    the Homestead Grays or the Cuban Stars, which is why it is not first.

    Then a name match over an alias match, and finally the order Parks lists
    them in, so the result does not depend on how the loop happens to run.
    """
    for s in seasons:
        s["info"] = s["candidates"][0] if len(s["candidates"]) == 1 else None

    for index, s in enumerate(seasons):
        if s["info"] or not s["candidates"]:
            continue

        # The nearest season either side that already knows its ballpark.
        nearby = []
        for step in (-1, 1):
            j = index + step
            while 0 <= j < len(seasons):
                if seasons[j]["info"]:
                    nearby.append(_city(seasons[j]["info"]))
                    break
                j += step

        team = (s["team"] or "").lower()
        best, best_score = None, None
        for rank, info in enumerate(s["candidates"]):
            city = _city(info)
            score = 0.0
            if city and city in nearby:
                score += 4
            if city and city.lower() in team:
                score += 2
            if (info.get("parkname") or "").strip() == s["name"]:
                score += 1
            score -= rank * 0.001        # ties keep Parks' own order
            if best_score is None or score > best_score:
                best, best_score = info, score
        s["info"] = best
    return seasons


def _sole_city(park_name, look):
    """The city of a park name that can only mean one building, else "".

    Deliberately gives up on an ambiguous name rather than guessing: the
    caller uses this as evidence that a club has moved, and a wrong city
    would invent a relocation. Seasons split over two grounds take the first.
    """
    name = (park_name or "").split("/")[0].strip()
    candidates = look.get(name) or []
    return _city(candidates[0]) if len(candidates) == 1 else ""


def _norm(s):
    """Park names for comparison, ignoring case and punctuation."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def other_names(info, recorded):
    """The park's other names — what it was called before or after.

    Lahman is inconsistent about which one it files a season under. The
    Marlins' ground appears season by season as Joe Robbie, Pro Player,
    Dolphin and Sun Life, but Cincinnati's is Crosley Field for all 58
    seasons from 1912, including the 22 when it was Redland Field. Parks
    carries the other names but no dates for them, so they are listed
    without a claim about when the sign changed.
    """
    if not info:
        return []
    names = [(info.get("parkname") or "").strip()]
    names += [a.strip() for a in (info.get("parkalias") or "").split(";")]
    # A spelling PARK_NAME_FIXES corrected is not another name the ground
    # went by — it is the mistake that made the two tables disagree, and
    # reprinting it as "also known as" would put the error back on the page.
    wrong = PARK_NAME_FIXES.get(recorded)
    return [n for n in names if n and n != recorded and n != wrong]


def park_runs(team_rows, look):
    """Consecutive seasons in one ballpark, oldest first.

    Seasons with no park on record are skipped rather than shown as a blank
    row; 56 team-seasons have none, nearly all of them touring clubs with no
    home ground to name.
    """
    # Every season's ground in order, then resolved together: an ambiguous name
    # is decided partly by the seasons around it, so they all have to be in
    # hand before any of them is settled.
    seasons = []
    for t in sorted(team_rows, key=lambda r: _int(r["yearID"])):
        year = _int(t["yearID"])
        raw = (t.get("park") or "").strip()
        # 31 seasons name two grounds, and three name a third: the club moved
        # during the year. Each is its own stretch, so Cincinnati reads
        # Crosley Field to 1970 and Riverfront Stadium from 1970.
        for name in (p.strip() for p in raw.split("/")):
            if name:
                seasons.append({"year": year, "name": name,
                                "team": t.get("name") or "",
                                "candidates": look.get(name, [])})
    resolve_parks(seasons, look)

    out = []
    for s in seasons:
        year, name, info = s["year"], s["name"], s["info"]
        # Lahman spells five parks two ways — Great American Ball Park and
        # Ballpark, Petco and PETCO — which would otherwise split one
        # ground into consecutive rows. Same park, so same run, keeping
        # whichever spelling Parks recognises.
        if out and _norm(out[-1]["park"]) == _norm(name):
            out[-1]["lastYear"] = year
            if info and not out[-1]["city"]:
                out[-1].update(
                    park=name,
                    parkkey=(info.get("parkkey") or "").strip(),
                    city=(info.get("city") or "").strip(),
                    state=(info.get("state") or "").strip(),
                    alias=other_names(info, name))
            continue
        out.append({
            "park": name,
            # The building, as distinct from what the sign said on it. Five
            # names over 57 years in Oakland are one ballpark, and without
            # this key a reader cannot tell a rename from a move.
            "parkkey": (info.get("parkkey") or "").strip() if info else "",
            "city": (info.get("city") or "").strip() if info else "",
            "state": (info.get("state") or "").strip() if info else "",
            "alias": other_names(info, name),
            "firstYear": year, "lastYear": year,
        })

    # Drop an other-name that is already a run of its own. Where Lahman did
    # record a rename season by season, both names are on the page already,
    # and naming each from the other just points the two rows at each other:
    # Riverfront Stadium "also Cinergy Field" sitting above Cinergy Field
    # "also Riverfront Stadium". Redland Field survives because Lahman never
    # filed a season under it.
    shown = {_norm(r["park"]) for r in out}
    for r in out:
        r["alias"] = ", ".join(a for a in r["alias"] if _norm(a) not in shown)
    return out


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

        # A location this module cannot read off the name carries the previous
        # one forward: missing data is not a move, and breaking the run would
        # list the same city twice around the gap.
        #
        # Unless the club is demonstrably somewhere else. The 2025 Athletics
        # are branded neither Oakland nor Sacramento — just "Athletics" — while
        # playing 80 miles from the city the run would otherwise extend. A
        # ballpark in a new city is the evidence that the silence is a move
        # rather than an omission, so it ends the run instead of prolonging it.
        loc_items, carried, carried_city = [], None, None
        for r in rows:
            city = _sole_city(r.get("park"), parks)
            loc = location_of(r["name"], vocab)
            if loc is None:
                moved = city and carried_city and city != carried_city
                loc = None if moved else carried
            carried = loc
            if city:
                carried_city = city
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
