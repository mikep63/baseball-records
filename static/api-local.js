/* In-browser query engine over the exported Lahman data (docs/data/*.csv).
   Implements the same endpoints/JSON shapes as app.py, so app.js works
   unchanged with no server. */
'use strict';

window.LocalAPI = (function () {
  const FILES = ['people', 'batting', 'pitching', 'fielding', 'teams',
    'awards', 'allstar', 'hof', 'seriespost', 'franchises', 'franchise_eras'];
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
    IDX.maxTeamG = new Map();          // yearID -> max team G
    IDX.lgTeamG = new Map();           // "yearID|lgID" -> max team G
    let minYear = Infinity, maxYear = 0;
    for (const t of D.teams) {
      if (t.yearID < minYear) minYear = t.yearID;
      if (t.yearID > maxYear) maxYear = t.yearID;
      const cur = IDX.maxTeamG.get(t.yearID) || 0;
      if ((t.G || 0) > cur) IDX.maxTeamG.set(t.yearID, t.G);
      const k = t.yearID + '|' + (t.lgID || '');
      if ((t.G || 0) > (IDX.lgTeamG.get(k) || 0)) IDX.lgTeamG.set(k, t.G);
    }
    IDX.minYear = minYear; IDX.maxYear = maxYear;
    IDX.batByPlayer = groupBy(D.batting, 'playerID');
    IDX.pitByPlayer = groupBy(D.pitching, 'playerID');
    IDX.fldByPlayer = groupBy(D.fielding, 'playerID');
    IDX.teamsByFranch = groupBy(D.teams, 'franchID');
    IDX.erasByFranch = groupBy(D.franchise_eras || [], 'franchID');
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

  function apiSearch(q) {
    const term = (q.q || '').trim();
    if (term.length < 2) return { players: [] };
    const rx = new RegExp(
      term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '.*'), 'i');
    const hits = [];
    for (const p of D.people) {
      const full = (p.nameFirst + ' ' + p.nameLast);
      if (rx.test(full) || rx.test(p.nameLast)) hits.push(p);
    }
    hits.sort((a, b) => nz(b.careerG) - nz(a.careerG));
    return {
      players: hits.slice(0, 25).map((p) => ({
        playerID: p.playerID,
        name: p.nameFirst + ' ' + p.nameLast,
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

    const awards = D.awards.filter((a) => a.playerID === pid)
      .sort((a, b) => a.yearID - b.yearID)
      .map((a) => ({ awardID: a.awardID, yearID: a.yearID, lgID: a.lgID, notes: null }));
    const allstar = D.allstar.filter((a) => a.playerID === pid)
      .map((a) => a.yearID).sort((a, b) => a - b);
    const hofRow = D.hof.find((h) => h.playerID === pid);
    return {
      bio: p,
      batting, battingTotals, pitching, pitchingTotals,
      fielding, awards, allstar,
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
        name: pe ? pe.nameFirst + ' ' + pe.nameLast : a.playerID,
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
        name: pe ? pe.nameFirst + ' ' + pe.nameLast : a.playerID,
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
        name: pe ? pe.nameFirst + ' ' + pe.nameLast : a.playerID,
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
      if ((t.G || 0) > (games.get(t.lgID) || 0)) games.set(t.lgID, t.G);
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
        for (const c of cols) a[c] = nz(a[c]) + nz(r[c]);
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
        name: pe ? pe.nameFirst + ' ' + pe.nameLast : r.playerID };
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
        return { cat, stat, label, value: res.best,
          leaders: res.winners.slice(0, 3).map(named), tied: res.winners.length };
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
      seasons,
    };
  }

  function apiLeaders(q) {
    const year = +q.year || 0;
    const stat = q.stat || 'HR', cat = q.cat || 'batting';
    const limit = Math.min(+q.limit || 10, 50);
    return { leaders: leaders(cat, stat, year, year, limit, true), stat, cat, year };
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
