/* In-browser query engine over the exported Lahman data (docs/data/*.csv).
   Implements the same endpoints/JSON shapes as app.py, so app.js works
   unchanged with no server. */
'use strict';

window.LocalAPI = (function () {
  const FILES = ['people', 'batting', 'pitching', 'fielding', 'teams',
    'awards', 'allstar', 'hof', 'seriespost', 'franchises', 'franchise_eras', 'managers',
    'franchise_parks'];
  // numeric columns per file (everything else stays a string)
  const NUMERIC = {
    people: ['birthYear', 'height', 'weight', 'careerG'],
    batting: ['yearID', 'stint', 'G', 'AB', 'R', 'H', '2B', '3B', 'HR',
      'RBI', 'SB', 'BB', 'SO', 'HBP', 'SH', 'SF'],
    pitching: ['yearID', 'stint', 'W', 'L', 'G', 'GS', 'CG', 'SHO', 'SV',
      'IPouts', 'H', 'ER', 'HR', 'BB', 'SO'],
    fielding: ['yearID', 'G', 'PO', 'A', 'E', 'DP'],
    teams: ['yearID', 'Rank', 'G', 'W', 'L', 'R', 'RA'],
    awards: ['yearID'],
    allstar: ['yearID'],
    hof: ['yearid'],
    seriespost: ['yearID', 'wins', 'losses', 'ties'],
    franchises: ['firstYear', 'lastYear', 'seasons', 'W', 'L', 'pennants',
      'titles', 'nameCount'],
    franchise_eras: ['firstYear', 'lastYear'],
    managers: ['yearID', 'inseason', 'G', 'W', 'L'],
    franchise_parks: ['firstYear', 'lastYear'],
  };

  const BATTING_STATS = {
    G: 'Games', AB: 'At Bats', R: 'Runs', H: 'Hits', '2B': 'Doubles',
    '3B': 'Triples', HR: 'Home Runs', RBI: 'RBI', SB: 'Stolen Bases',
    BB: 'Walks', SO: 'Strikeouts', TB: 'Total Bases',
    AVG: 'Batting Average', OBP: 'On-Base %', SLG: 'Slugging %', OPS: 'OPS',
  };
  const PITCHING_STATS = {
    W: 'Wins', L: 'Losses', G: 'Games', GS: 'Starts', CG: 'Complete Games',
    SHO: 'Shutouts', SV: 'Saves', IP: 'Innings Pitched', SO: 'Strikeouts',
    BB: 'Walks', ERA: 'ERA', WHIP: 'WHIP',
  };
  /* The column that must actually have been recorded for a stat to mean
     anything in a given league-season. Stolen bases went unrecorded in 22
     league-seasons and batter strikeouts in 53; without this every player
     reads as zero and ties, which is how the 1884 Union Association listed
     276 stolen-base "leaders". Rate stats point at their numerator, since a
     missing denominator already yields null and drops out on its own. */
  const BATTING_SOURCE = {
    G: 'G', AB: 'AB', R: 'R', H: 'H', '2B': '2B', '3B': '3B', HR: 'HR',
    RBI: 'RBI', SB: 'SB', BB: 'BB', SO: 'SO',
    TB: 'H', AVG: 'H', OBP: 'H', SLG: 'H', OPS: 'H',
  };
  const PITCHING_SOURCE = {
    W: 'W', L: 'L', G: 'G', GS: 'GS', CG: 'CG', SHO: 'SHO', SV: 'SV',
    SO: 'SO', BB: 'BB', IP: 'IPouts', ERA: 'ER', WHIP: 'H',
  };

  const RATE_BATTING = ['AVG', 'OBP', 'SLG', 'OPS'];
  const RATE_PITCHING = ['ERA', 'WHIP'];
  const ASCENDING = ['ERA', 'WHIP'];

  const D = {};          // file -> array of row objects
  const IDX = {};        // built indexes
  let readyResolve;
  const ready = new Promise((res) => { readyResolve = res; });

  /* ---------------------------------------------------- CSV parsing */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function ingest(name, text) {
    const raw = parseCSV(text);
    const header = raw[0];
    const numeric = new Set(NUMERIC[name] || []);
    const out = new Array(raw.length - 1);
    for (let i = 1; i < raw.length; i++) {
      const obj = {};
      const r = raw[i];
      for (let c = 0; c < header.length; c++) {
        const v = r[c];
        if (numeric.has(header[c])) obj[header[c]] = (v === '' || v == null) ? null : +v;
        else obj[header[c]] = v == null ? '' : v;
      }
      out[i - 1] = obj;
    }
    D[name] = out;
  }

  function finalize() {
    IDX.person = new Map(D.people.map((p) => [p.playerID, p]));
    IDX.hofIds = new Set(D.hof.map((h) => h.playerID));
    /* Schedule length is counted in games that were decided, not games
       played. Teams.G includes ties, which were replayed rather than settled
       before lights and belong to nobody's schedule: the 1989 Pirates show
       G=164 against a 162-game season, the 1904 Athletics G=162 against 154.
       Using G holds those leagues to a bar up to eight games too high, which
       is enough to move a batting title. */
    IDX.maxTeamG = new Map();          // yearID -> longest schedule
    IDX.lgTeamG = new Map();           // "yearID|lgID" -> longest schedule
    let minYear = Infinity, maxYear = 0;
    for (const t of D.teams) {
      if (t.yearID < minYear) minYear = t.yearID;
      if (t.yearID > maxYear) maxYear = t.yearID;
      const decided = nz(t.W) + nz(t.L);
      if (decided > (IDX.maxTeamG.get(t.yearID) || 0)) {
        IDX.maxTeamG.set(t.yearID, decided);
      }
      const k = t.yearID + '|' + (t.lgID || '');
      if (decided > (IDX.lgTeamG.get(k) || 0)) IDX.lgTeamG.set(k, decided);
    }
    IDX.minYear = minYear; IDX.maxYear = maxYear;
    IDX.batByPlayer = groupBy(D.batting, 'playerID');
    IDX.pitByPlayer = groupBy(D.pitching, 'playerID');
    IDX.fldByPlayer = groupBy(D.fielding, 'playerID');
    IDX.teamsByFranch = groupBy(D.teams, 'franchID');
    IDX.erasByFranch = groupBy(D.franchise_eras || [], 'franchID');
    IDX.parksByFranch = groupBy(D.franchise_parks || [], 'franchID');
    // who ran each club that year, in the order they held the job
    // every series a club played that October, for the franchise page
    IDX.postByTeamYear = new Map();
    for (const s of D.seriespost) {
      for (const [tid, won] of [[s.teamIDwinner, 1], [s.teamIDloser, 0]]) {
        if (!tid) continue;
        const k = s.yearID + '|' + tid;
        if (!IDX.postByTeamYear.has(k)) IDX.postByTeamYear.set(k, []);
        IDX.postByTeamYear.get(k).push({ round: s.round, won });
      }
    }
    IDX.mgrByTeamYear = new Map();
    for (const m of (D.managers || []).slice()
        .sort((a, b) => a.inseason - b.inseason)) {
      const k = m.yearID + '|' + m.teamID;
      if (!IDX.mgrByTeamYear.has(k)) IDX.mgrByTeamYear.set(k, []);
      IDX.mgrByTeamYear.get(k).push(m);
    }
    readyResolve();
  }

  function groupBy(rows, key) {
    const m = new Map();
    for (const r of rows) {
      const k = r[key];
      let arr = m.get(k);
      if (!arr) { arr = []; m.set(k, arr); }
      arr.push(r);
    }
    return m;
  }

  async function init() {
    const texts = await Promise.all(FILES.map((f) =>
      fetch('data/' + f + '.csv').then((r) => {
        if (!r.ok) throw new Error('failed to load ' + f);
        return r.text();
      })));
    FILES.forEach((f, i) => ingest(f, texts[i]));
    finalize();
  }

  /* ---------------------------------------------------- stat math */
  const nz = (v) => (v == null ? 0 : v);
  /* 413 players, all from the Negro League records, have no first name;
     plain concatenation leaves a leading space. */
  const fullName = (p) => ((p.nameFirst || '') + ' ' + (p.nameLast || '')).trim();

  function batValue(stat, s) {   // s: object with summed batting columns
    const ab = nz(s.AB), h = nz(s.H);
    const tb = h + nz(s['2B']) + 2 * nz(s['3B']) + 3 * nz(s.HR);
    const obpDen = ab + nz(s.BB) + nz(s.HBP) + nz(s.SF);
    const obpNum = h + nz(s.BB) + nz(s.HBP);
    switch (stat) {
      case 'TB': return tb;
      case 'AVG': return ab > 0 ? h / ab : null;
      case 'SLG': return ab > 0 ? tb / ab : null;
      case 'OBP': return obpDen > 0 ? obpNum / obpDen : null;
      case 'OPS': return (obpDen > 0 ? obpNum / obpDen : 0) + (ab > 0 ? tb / ab : 0);
      default: return nz(s[stat]);
    }
  }

  function pitValue(stat, s) {
    const ipo = nz(s.IPouts), ip = ipo / 3.0;
    switch (stat) {
      case 'IP': return ip;
      case 'ERA': return ipo > 0 ? 9.0 * nz(s.ER) / ip : null;
      case 'WHIP': return ipo > 0 ? (nz(s.BB) + nz(s.H)) / ip : null;
      default: return nz(s[stat]);
    }
  }

  const paOf = (s) => nz(s.AB) + nz(s.BB) + nz(s.HBP) + nz(s.SH) + nz(s.SF);
  const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

  /* Games the player's own league played — the base of the official rate
     qualifier. A player traded across leagues mid-season is held to the
     longest schedule he appeared in.

     Floored at MIN_SCHEDULE: some Lahman "leagues" are barnstorming
     fragments of a few recorded games, where 3.1 per game is a bar of three
     plate appearances and a 1-for-1 day wins the batting title. The
     recognised Negro major leagues all played 40+, so the floor leaves them
     on the real rule and only bites the fragments. */
  const MIN_SCHEDULE = 40;

  function leagueGames(a) {
    let g = 0;
    a.lgs.forEach((lg) => {
      const v = IDX.lgTeamG.get(a.yearID + '|' + (lg || '')) || 0;
      if (v > g) g = v;
    });
    return Math.max(g || IDX.maxTeamG.get(a.yearID) || 162, MIN_SCHEDULE);
  }

  /* ---------------------------------------------------- endpoints */
  function apiMeta() {
    return {
      minYear: IDX.minYear, maxYear: IDX.maxYear,
      battingStats: BATTING_STATS, pitchingStats: PITCHING_STATS,
      rateStats: RATE_BATTING.concat(RATE_PITCHING).sort(),
    };
  }

  /* Match quality, then fame, then playing time. Career games alone buries
     pitchers, who play a fraction of the games a position player does, and
     Negro League players, whose seasons ran 60 to 90 games rather than 154 —
     which is how "young" returned three journeyman infielders above Cy Young.
     Hall of Fame membership corrects both, since it does not care how the
     games were accumulated. Match quality still wins: a term buried mid-word
     ("ruth" in Caruthers) should not outrank the players named for it. */
  function matchTier(low, p) {
    const first = (p.nameFirst || '').toLowerCase();
    const last = (p.nameLast || '').toLowerCase();
    const full = (first + ' ' + last).trim();
    if (full === low || last === low) return 0;
    if (last.startsWith(low)) return 1;
    if (first.startsWith(low) || full.startsWith(low)) return 2;
    return 3;
  }

  function apiSearch(q) {
    const term = (q.q || '').trim();
    if (term.length < 2) return { players: [] };
    const low = term.toLowerCase();
    const rx = new RegExp(
      term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '.*'), 'i');
    const hits = [];
    for (const p of D.people) {
      const full = fullName(p);
      if (rx.test(full) || rx.test(p.nameLast)) hits.push(p);
    }
    hits.sort((a, b) =>
      matchTier(low, a) - matchTier(low, b) ||
      (IDX.hofIds.has(a.playerID) ? 0 : 1) - (IDX.hofIds.has(b.playerID) ? 0 : 1) ||
      nz(b.careerG) - nz(a.careerG));
    return {
      players: hits.slice(0, 25).map((p) => ({
        playerID: p.playerID,
        name: fullName(p),
        birthYear: p.birthYear,
        debut: (p.debut || '').slice(0, 4),
        finalGame: (p.finalGame || '').slice(0, 4),
        careerG: nz(p.careerG),
      })),
    };
  }

  function sumInto(acc, row, cols) {
    for (const c of cols) acc[c] = nz(acc[c]) + nz(row[c]);
  }
  const BAT_SUM_COLS = ['G', 'AB', 'R', 'H', '2B', '3B', 'HR', 'RBI', 'SB',
    'BB', 'SO', 'HBP', 'SH', 'SF'];
  const PIT_SUM_COLS = ['W', 'L', 'G', 'GS', 'CG', 'SHO', 'SV', 'IPouts',
    'H', 'ER', 'HR', 'BB', 'SO'];

  function apiPlayer(pid) {
    const p = IDX.person.get(pid);
    if (!p) return { error: 'player not found' };

    const batRows = (IDX.batByPlayer.get(pid) || []).slice()
      .sort((a, b) => a.yearID - b.yearID || a.stint - b.stint);
    const batting = batRows.map((s) => ({
      yearID: s.yearID, stint: s.stint, teamID: s.teamID, lgID: s.lgID,
      G: s.G, AB: s.AB, R: s.R, H: s.H, D2: s['2B'], D3: s['3B'], HR: s.HR,
      RBI: s.RBI, SB: s.SB, BB: s.BB, SO: s.SO, HBP: s.HBP, SF: s.SF,
      TB: batValue('TB', s), AVG: batValue('AVG', s), OBP: batValue('OBP', s),
      SLG: batValue('SLG', s), OPS: batValue('OPS', s),
    }));
    let battingTotals = null;
    if (batRows.length) {
      const acc = {};
      const years = new Set();
      for (const s of batRows) { sumInto(acc, s, BAT_SUM_COLS); years.add(s.yearID); }
      battingTotals = {
        years: years.size, G: acc.G, AB: acc.AB, R: acc.R, H: acc.H,
        D2: acc['2B'], D3: acc['3B'], HR: acc.HR, RBI: acc.RBI, SB: acc.SB,
        BB: acc.BB, SO: acc.SO,
        TB: batValue('TB', acc), AVG: batValue('AVG', acc),
        OBP: batValue('OBP', acc), SLG: batValue('SLG', acc),
        OPS: acc.AB > 0 ? batValue('OPS', acc) : null,
      };
    }

    const pitRows = (IDX.pitByPlayer.get(pid) || []).slice()
      .sort((a, b) => a.yearID - b.yearID || a.stint - b.stint);
    const pitching = pitRows.map((s) => ({
      yearID: s.yearID, stint: s.stint, teamID: s.teamID, lgID: s.lgID,
      W: s.W, L: s.L, G: s.G, GS: s.GS, CG: s.CG, SHO: s.SHO, SV: s.SV,
      IP: round1(nz(s.IPouts) / 3.0), H: s.H, ER: s.ER, HR: s.HR,
      BB: s.BB, SO: s.SO, ERA: pitValue('ERA', s), WHIP: pitValue('WHIP', s),
    }));
    let pitchingTotals = null;
    if (pitRows.length) {
      const acc = {};
      const years = new Set();
      for (const s of pitRows) { sumInto(acc, s, PIT_SUM_COLS); years.add(s.yearID); }
      pitchingTotals = {
        years: years.size, W: acc.W, L: acc.L, G: acc.G, GS: acc.GS,
        CG: acc.CG, SHO: acc.SHO, SV: acc.SV, IPouts: acc.IPouts,
        H: acc.H, ER: acc.ER, HR: acc.HR, BB: acc.BB, SO: acc.SO,
        IP: round1(nz(acc.IPouts) / 3.0),
        ERA: pitValue('ERA', acc), WHIP: pitValue('WHIP', acc),
      };
    }

    const posAgg = new Map();
    for (const f of (IDX.fldByPlayer.get(pid) || [])) {
      let a = posAgg.get(f.POS);
      if (!a) { a = { POS: f.POS, years: new Set(), G: 0, PO: 0, A: 0, E: 0, DP: 0 }; posAgg.set(f.POS, a); }
      a.years.add(f.yearID);
      a.G += nz(f.G); a.PO += nz(f.PO); a.A += nz(f.A);
      a.E += nz(f.E); a.DP += nz(f.DP);
    }
    const fielding = Array.from(posAgg.values())
      .map((a) => ({ POS: a.POS, years: a.years.size, G: a.G, PO: a.PO, A: a.A, E: a.E, DP: a.DP }))
      .sort((a, b) => b.G - a.G);

    /* Primary position per season, collapsed into contiguous runs. The career
       table above says where a player spent his time; this says when, which is
       what the totals destroy. Only his most-played position each season
       counts, so a shortstop's one inning in the outfield does not break the
       run, and a missed season does not either — Musial went to war in 1945,
       which is not a position change. Ties go to the alphabetically first
       position, matching the server's ORDER BY G DESC, POS. */
    const posByYear = new Map();
    for (const f of (IDX.fldByPlayer.get(pid) || [])) {
      const cur = posByYear.get(f.yearID);
      const g = nz(f.G);
      if (!cur || g > cur.g || (g === cur.g && f.POS < cur.POS)) {
        posByYear.set(f.yearID, { POS: f.POS, g });
      }
    }
    const positions = [];
    for (const y of Array.from(posByYear.keys()).sort((a, b) => a - b)) {
      const pos = posByYear.get(y).POS;
      const last = positions[positions.length - 1];
      if (last && last.POS === pos) last.lastYear = y;
      else positions.push({ POS: pos, firstYear: y, lastYear: y });
    }

    const awards = D.awards.filter((a) => a.playerID === pid)
      .sort((a, b) => a.yearID - b.yearID)
      .map((a) => ({ awardID: a.awardID, yearID: a.yearID, lgID: a.lgID, notes: null }));
    const allstar = D.allstar.filter((a) => a.playerID === pid)
      .map((a) => a.yearID).sort((a, b) => a - b);
    const hofRow = D.hof.find((h) => h.playerID === pid);
    return {
      bio: p,
      batting, battingTotals, pitching, pitchingTotals,
      fielding, positions, awards, allstar,
      hof: hofRow ? { yearid: hofRow.yearid, votedBy: hofRow.votedBy, category: hofRow.category } : null,
      postBatting: null,
    };
  }

  function apiTeams(q) {
    const year = +q.year || 0;
    const teams = D.teams.filter((t) => t.yearID === year)
      .map((t) => ({
        yearID: t.yearID, lgID: t.lgID, divID: t.divID, teamID: t.teamID,
        name: t.name, Rank: t.Rank, G: t.G, W: t.W, L: t.L, R: t.R, RA: t.RA,
        wonWS: t.WSWin === 'Y' ? 1 : 0, wonLg: t.LgWin === 'Y' ? 1 : 0,
      }))
      .sort((a, b) =>
        (a.lgID || '').localeCompare(b.lgID || '') ||
        (a.divID || '').localeCompare(b.divID || '') ||
        nz(a.Rank) - nz(b.Rank) || nz(b.W) - nz(a.W));
    return { teams };
  }

  function apiPostseason(q) {
    const year = +q.year || 0;
    const names = new Map();
    for (const t of D.teams) {
      if (t.yearID === year) names.set(t.teamID, t.name);
    }
    const series = D.seriespost.filter((s) => s.yearID === year).map((s) => ({
      round: s.round,
      teamIDwinner: s.teamIDwinner, lgIDwinner: s.lgIDwinner,
      teamIDloser: s.teamIDloser, lgIDloser: s.lgIDloser,
      wins: s.wins, losses: s.losses, ties: s.ties,
      winnerName: names.get(s.teamIDwinner) || null,
      loserName: names.get(s.teamIDloser) || null,
    }));
    return { series, year };
  }

  function apiRoster(q) {
    const year = +q.year || 0, team = q.team || '';
    // POS with most games per player for this year+team
    const posBest = new Map();
    for (const f of D.fielding) {
      if (f.yearID !== year || f.teamID !== team) continue;
      const cur = posBest.get(f.playerID);
      if (!cur || nz(f.G) > cur.g) posBest.set(f.playerID, { pos: f.POS, g: nz(f.G) });
    }
    const bAgg = new Map();
    for (const b of D.batting) {
      if (b.yearID !== year || b.teamID !== team) continue;
      let a = bAgg.get(b.playerID);
      if (!a) { a = { playerID: b.playerID }; bAgg.set(b.playerID, a); }
      sumInto(a, b, BAT_SUM_COLS);
    }
    const batters = Array.from(bAgg.values()).map((a) => {
      const pe = IDX.person.get(a.playerID);
      return {
        playerID: a.playerID,
        name: pe ? fullName(pe) : a.playerID,
        POS: (posBest.get(a.playerID) || {}).pos || '',
        G: a.G, AB: a.AB, R: a.R, H: a.H, D2: a['2B'], D3: a['3B'],
        HR: a.HR, RBI: a.RBI, SB: a.SB, BB: a.BB,
        AVG: a.AB > 0 ? a.H / a.AB : null,
      };
    }).sort((x, y) => nz(y.AB) - nz(x.AB) || nz(y.G) - nz(x.G));

    const pAgg = new Map();
    for (const p of D.pitching) {
      if (p.yearID !== year || p.teamID !== team) continue;
      let a = pAgg.get(p.playerID);
      if (!a) { a = { playerID: p.playerID }; pAgg.set(p.playerID, a); }
      sumInto(a, p, PIT_SUM_COLS);
    }
    const pitchers = Array.from(pAgg.values()).map((a) => {
      const pe = IDX.person.get(a.playerID);
      return {
        playerID: a.playerID,
        name: pe ? fullName(pe) : a.playerID,
        W: a.W, L: a.L, G: a.G, GS: a.GS, SV: a.SV,
        IP: round1(nz(a.IPouts) / 3.0), SO: a.SO, BB: a.BB,
        ERA: pitValue('ERA', a),
      };
    }).sort((x, y) => nz(y.IP) - nz(x.IP));

    const t = D.teams.find((r) => r.yearID === year && r.teamID === team);
    return {
      team: t ? { name: t.name, W: t.W, L: t.L, Rank: t.Rank, lgID: t.lgID, divID: t.divID } : null,
      batters, pitchers,
    };
  }

  function leaders(cat, stat, y0, y1, limit, perSeason) {
    const pitching = cat === 'pitching';
    const stats = pitching ? PITCHING_STATS : BATTING_STATS;
    if (!(stat in stats)) throw new Error('bad stat');
    const rows = pitching ? D.pitching : D.batting;
    const sumCols = pitching ? PIT_SUM_COLS : BAT_SUM_COLS;
    const valueFn = pitching ? pitValue : batValue;
    const isRate = (pitching ? RATE_PITCHING : RATE_BATTING).includes(stat);
    const asc = ASCENDING.includes(stat);

    const agg = new Map();
    for (const r of rows) {
      if (r.yearID < y0 || r.yearID > y1) continue;
      const key = perSeason ? r.playerID + '|' + r.yearID : r.playerID;
      let a = agg.get(key);
      if (!a) {
        a = { playerID: r.playerID, yearID: perSeason ? r.yearID : null,
          teams: new Set(), years: new Set(), lgs: new Set(), teamID: r.teamID };
        agg.set(key, a);
      }
      a.teams.add(r.teamID);
      a.years.add(r.yearID);
      a.lgs.add(r.lgID);
      if (r.teamID < a.teamID) a.teamID = r.teamID;
      sumInto(a, r, sumCols);
    }

    const nyears = y1 - y0 + 1;
    const minPA = Math.min(3000, 400 * nyears);
    const minIP = Math.min(1000, 130 * nyears);
    const out = [];
    for (const a of agg.values()) {
      const value = valueFn(stat, a);
      if (value == null) continue;
      if (isRate) {
        if (!pitching) {
          const need = perSeason ? 3.1 * leagueGames(a) : minPA;
          if (paOf(a) < need) continue;
        } else {
          const need = perSeason ? leagueGames(a) : minIP;
          if (nz(a.IPouts) / 3.0 < need) continue;
        }
      }
      out.push(a2row(a, value));
    }
    out.sort((x, y) => (asc ? x.value - y.value : y.value - x.value)
      || (x.playerID < y.playerID ? -1 : 1));
    return out.slice(0, limit);

    function a2row(a, value) {
      const pe = IDX.person.get(a.playerID);
      let first = Infinity, last = 0;
      a.years.forEach((y) => {
        if (y < first) first = y;
        if (y > last) last = y;
      });
      return {
        playerID: a.playerID, yearID: a.yearID,
        nyears: a.years.size, firstYear: first, lastYear: last,
        nteams: a.teams.size, teamID: a.teamID,
        value,
        name: pe ? fullName(pe) : a.playerID,
      };
    }
  }

  /* The two Triple Crowns, which is what a season is remembered by.
     Deliberately not the full stat catalogue — the Leaders tab is there for
     that, and this panel earns its place by being glanceable. */
  const DASHBOARD_STATS = [['batting', 'AVG'], ['batting', 'HR'],
    ['batting', 'RBI'], ['pitching', 'W'], ['pitching', 'ERA'],
    ['pitching', 'SO']];

  function dashboardTop(rows, valueOf, qualifies, ascending) {
    let best = null, winners = [];
    for (const r of rows) {
      if (!qualifies(r)) continue;
      let v = valueOf(r);
      if (v == null) continue;
      v = Math.round(v * 1e9) / 1e9;
      if (best == null || (ascending ? v < best : v > best)) {
        best = v; winners = [r];
      } else if (v === best) winners.push(r);
    }
    return { best, winners };
  }

  function apiSeasonDashboard(q) {
    const year = +q.year || 0;
    const games = new Map();
    for (const t of D.teams) {
      if (t.yearID !== year || !t.lgID) continue;
      const decided = nz(t.W) + nz(t.L);   // ties are not schedule, see finalize
      if (decided > (games.get(t.lgID) || 0)) games.set(t.lgID, decided);
    }
    if (!games.size) return { year, leagues: [] };

    // one pass per table, aggregating each player within each league
    const agg = (rows, cols) => {
      const m = new Map();
      for (const r of rows) {
        if (r.yearID !== year || !r.lgID) continue;
        const k = r.lgID + '|' + r.playerID;
        let a = m.get(k);
        if (!a) {
          a = { lgID: r.lgID, playerID: r.playerID, teamID: r.teamID };
          m.set(k, a);
        }
        if (r.teamID < a.teamID) a.teamID = r.teamID;
        for (const c of cols) {
          if (r[c] != null) a[c] = nz(a[c]) + r[c];   // null stays null
        }
        a.PA = nz(a.PA) + paOf(r);
      }
      return m;
    };
    const bat = agg(D.batting, ['H', 'AB', 'HR', 'RBI']);
    const pit = agg(D.pitching, ['W', 'SO', 'IPouts', 'ER']);
    const byLg = new Map();
    for (const a of bat.values()) {
      if (!byLg.has(a.lgID)) byLg.set(a.lgID, { b: [], p: [] });
      byLg.get(a.lgID).b.push(a);
    }
    for (const a of pit.values()) {
      if (!byLg.has(a.lgID)) byLg.set(a.lgID, { b: [], p: [] });
      byLg.get(a.lgID).p.push(a);
    }

    const named = (r) => {
      const pe = IDX.person.get(r.playerID);
      return { playerID: r.playerID, teamID: r.teamID,
        name: pe ? fullName(pe) : r.playerID };
    };

    const leagues = Array.from(games.keys()).sort().map((lg) => {
      const rows = byLg.get(lg) || { b: [], p: [] };
      const bar = Math.max(games.get(lg) || 0, MIN_SCHEDULE);
      const tiles = DASHBOARD_STATS.map(([cat, stat]) => {
        let res, label;
        if (cat === 'batting') {
          label = BATTING_STATS[stat];
          res = stat === 'AVG'
            ? dashboardTop(rows.b, (r) => (r.AB ? r.H / r.AB : null),
              (r) => nz(r.PA) >= 3.1 * bar, false)
            : dashboardTop(rows.b, (r) => nz(r[stat]), () => true, false);
        } else {
          label = PITCHING_STATS[stat];
          res = stat === 'ERA'
            ? dashboardTop(rows.p, (r) => (r.IPouts ? 9.0 * nz(r.ER) / (r.IPouts / 3.0) : null),
              (r) => nz(r.IPouts) / 3.0 >= bar, true)
            : dashboardTop(rows.p, (r) => nz(r[stat]), () => true, false);
        }
        // a column the league never kept reads as zero for everyone and ties
        // the whole roster — 1903 Eastern Independent Clubs had 24 home run
        // "leaders" on nothing. Say it was not recorded instead.
        const src = (cat === 'batting' ? BATTING_SOURCE : PITCHING_SOURCE)[stat];
        const pool = cat === 'batting' ? rows.b : rows.p;
        let recorded = pool.some((r) => r[src] != null);
        let value = res.best, winners = res.winners;
        if (!recorded || (value === 0 && !ASCENDING.includes(stat))) {
          value = null; winners = []; recorded = false;
        }
        return { cat, stat, label, value, recorded,
          leaders: winners.slice(0, 3).map(named), tied: winners.length };
      });
      return { lgID: lg, games: games.get(lg), tiles };
    });
    return { year, leagues };
  }

  /* Franchise history is precomputed by build_site.py (franchises.py owns
     the name/location era logic); here it only needs reshaping. */
  function franchiseSummary(f) {
    return Object.assign({}, f, {
      former: f.former ? f.former.split('|') : [],
    });
  }

  function apiFranchises() {
    return { franchises: D.franchises.map(franchiseSummary) };
  }

  function apiFranchise(fid) {
    const f = D.franchises.find((r) => r.franchID === fid);
    if (!f) return { error: 'franchise not found' };
    const eras = (IDX.erasByFranch.get(fid) || [])
      .slice().sort((a, b) => a.firstYear - b.firstYear);
    const seasons = (IDX.teamsByFranch.get(fid) || []).slice()
      .sort((a, b) => a.yearID - b.yearID)
      .map((t) => ({
        yearID: t.yearID, teamID: t.teamID, lgID: t.lgID, divID: t.divID,
        name: t.name, Rank: t.Rank, G: t.G, W: t.W, L: t.L, R: t.R, RA: t.RA,
        wonWS: t.WSWin === 'Y' ? 1 : 0, wonLg: t.LgWin === 'Y' ? 1 : 0,
        post: IDX.postByTeamYear.get(t.yearID + '|' + t.teamID) || [],
        managers: (IDX.mgrByTeamYear.get(t.yearID + '|' + t.teamID) || [])
          .map((m) => {
            const pe = IDX.person.get(m.playerID);
            return { name: pe ? fullName(pe) : m.playerID,
              playerMgr: m.plyrMgr === 'Y' };
          }),
      }));
    return {
      franchise: franchiseSummary(f),
      eras: eras.filter((e) => e.kind === 'name').map((e) => ({
        name: e.label, firstYear: e.firstYear, lastYear: e.lastYear,
        teamID: e.teamID, lgID: e.lgID,
      })),
      locations: eras.filter((e) => e.kind === 'location').map((e) => ({
        location: e.label, firstYear: e.firstYear, lastYear: e.lastYear,
      })),
      parks: (IDX.parksByFranch.get(fid) || []).slice()
        .sort((a, b) => a.firstYear - b.firstYear)
        .map((p) => ({ park: p.park, city: p.city, state: p.state,
          firstYear: p.firstYear, lastYear: p.lastYear })),
      seasons,
    };
  }

  /* Each league's leader in one stat, every year, newest first. The other
     spans answer "who was best" once; this answers it repeatedly, so one page
     carries the whole line of succession. Ties are kept, not broken. */
  function apiHistory(q) {
    let y0 = +q.start || 0, y1 = +q.end || 0;
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    const stat = q.stat || 'HR', cat = q.cat || 'batting';
    const pitching = cat === 'pitching';
    const stats = pitching ? PITCHING_STATS : BATTING_STATS;
    if (!(stat in stats)) throw new Error('bad stat');
    const src = pitching ? D.pitching : D.batting;
    const sumCols = pitching ? PIT_SUM_COLS : BAT_SUM_COLS;
    const valueFn = pitching ? pitValue : batValue;
    const isRate = (pitching ? RATE_PITCHING : RATE_BATTING).includes(stat);
    const asc = ASCENDING.includes(stat);

    const srcCol = (pitching ? PITCHING_SOURCE : BATTING_SOURCE)[stat];
    const recorded = new Set();   // "year|lg" that kept this column at all

    const agg = new Map();
    for (const r of src) {
      if (r.yearID < y0 || r.yearID > y1 || !r.lgID) continue;
      const lgKey = r.yearID + '|' + r.lgID;
      if (r[srcCol] != null) recorded.add(lgKey);
      const k = lgKey + '|' + r.playerID;
      let a = agg.get(k);
      if (!a) {
        a = { yearID: r.yearID, lgID: r.lgID, playerID: r.playerID, teamID: r.teamID };
        agg.set(k, a);
      }
      if (r.teamID < a.teamID) a.teamID = r.teamID;
      sumInto(a, r, sumCols);
    }

    const best = new Map();
    for (const a of agg.values()) {
      if (!recorded.has(a.yearID + '|' + a.lgID)) continue;
      const bar = Math.max(IDX.lgTeamG.get(a.yearID + '|' + a.lgID) || 0, MIN_SCHEDULE);
      if (isRate) {
        if (!pitching && paOf(a) < 3.1 * bar) continue;
        if (pitching && nz(a.IPouts) / 3.0 < bar) continue;
      }
      let v = valueFn(stat, a);
      if (v == null) continue;
      v = Math.round(v * 1e9) / 1e9;
      const k = a.yearID + '|' + a.lgID;
      const e = best.get(k);
      if (!e || (asc ? v < e.value : v > e.value)) {
        best.set(k, { yearID: a.yearID, lgID: a.lgID, value: v, rows: [a] });
      } else if (v === e.value) e.rows.push(a);
    }

    const named = (a) => {
      const pe = IDX.person.get(a.playerID);
      return { name: pe ? fullName(pe) : a.playerID,
        teamID: a.teamID };
    };
    // a leader of zero is not a leader; only where more is better, since a
    // 0.00 earned run average is a real result
    const out = Array.from(best.values())
      .filter((e) => asc || e.value > 0)
      .map((e) => ({
      yearID: e.yearID, lgID: e.lgID, value: e.value, tied: e.rows.length,
      leaders: e.rows.map(named).sort((x, y) => (x.name < y.name ? -1 : 1)),
    }));
    out.sort((a, b) => b.yearID - a.yearID || (a.lgID < b.lgID ? -1 : 1));
    return { rows: out, stat, cat, start: y0, end: y1 };
  }

  function apiLeaders(q) {
    const year = +q.year || 0;
    const stat = q.stat || 'HR', cat = q.cat || 'batting';
    const limit = Math.min(+q.limit || 10, 50);
    return { leaders: leaders(cat, stat, year, year, limit, true), stat, cat, year };
  }

  /* Best individual seasons in a span — one row per player-season. The other
     span modes aggregate, so over all years they answer "most career home
     runs"; this answers "best home run season" instead. */
  function apiBestSeasons(q) {
    let y0 = +q.start || 0, y1 = +q.end || 0;
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    const stat = q.stat || 'HR', cat = q.cat || 'batting';
    const limit = Math.min(+q.limit || 10, 50);
    return { leaders: leaders(cat, stat, y0, y1, limit, true), stat, cat, start: y0, end: y1 };
  }

  function apiLeadersRange(q) {
    let y0 = +q.start || 0, y1 = +q.end || 0;
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    const stat = q.stat || 'HR', cat = q.cat || 'batting';
    const limit = Math.min(+q.limit || 10, 50);
    return { leaders: leaders(cat, stat, y0, y1, limit, false), stat, cat, start: y0, end: y1 };
  }

  /* ---------------------------------------------------- dispatch */
  function parseQuery(qs) {
    const out = {};
    if (!qs) return out;
    for (const pair of qs.split('&')) {
      const i = pair.indexOf('=');
      if (i < 0) continue;
      out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
    }
    return out;
  }

  async function handle(path) {
    await ready;
    const qi = path.indexOf('?');
    const route = qi < 0 ? path : path.slice(0, qi);
    const q = parseQuery(qi < 0 ? '' : path.slice(qi + 1));
    if (route === 'meta') return apiMeta();
    if (route === 'search') return apiSearch(q);
    if (route.startsWith('player/')) return apiPlayer(decodeURIComponent(route.slice(7)));
    if (route === 'teams') return apiTeams(q);
    if (route === 'postseason') return apiPostseason(q);
    if (route === 'roster') return apiRoster(q);
    if (route === 'leaders') return apiLeaders(q);
    if (route === 'leaders_range') return apiLeadersRange(q);
    if (route === 'best_seasons') return apiBestSeasons(q);
    if (route === 'history') return apiHistory(q);
    if (route === 'season_leaders') return apiSeasonDashboard(q);
    if (route === 'franchises') return apiFranchises();
    if (route.startsWith('franchise/')) return apiFranchise(decodeURIComponent(route.slice(10)));
    throw new Error('unknown route: ' + route);
  }

  return { handle, init, _ingest: ingest, _finalize: finalize };
})();

/* auto-start in the browser (jsc tests drive _ingest/_finalize directly) */
if (typeof fetch === 'function' && typeof document !== 'undefined') {
  window.LocalAPI.init().catch((e) => {
    document.body.innerHTML = '<p style="padding:2rem">Failed to load data: ' + e + '</p>';
  });
}
