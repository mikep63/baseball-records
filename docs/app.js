/* Baseball Records frontend */
'use strict';

const $ = (sel) => document.querySelector(sel);
let META = null;

/* Awards shown in the main table, in the order they are listed here.
   Everything else — press selections (Baseball Magazine, Sporting News),
   All-MLB teams, and weekly/monthly honors — collapses into a summary
   below it. */
const MAJOR_AWARD_ORDER = [
  'Most Valuable Player', 'Cy Young Award', 'Rookie of the Year',
  'Triple Crown', 'Pitching Triple Crown',
  'World Series MVP', 'ALCS MVP', 'NLCS MVP', 'All-Star Game MVP',
  'Gold Glove', 'Platinum Glove', 'Silver Slugger',
  'Reliever of the Year Award', 'Reliever of the Year',
  'Comeback Player of the Year', 'Outstanding DH Award',
  'Roberto Clemente Award', 'Hank Aaron Award',
  'Lou Gehrig Memorial Award', 'Babe Ruth Award',
  'Branch Rickey Award', 'Hutch Award',
];
const MAJOR_AWARDS = new Set(MAJOR_AWARD_ORDER);

/* award -> Map(year -> times won that year).

   A year's count is the most wins recorded in any single league, because
   some sources list one honor twice — once for the league team and once
   for an all-MLB team. Repeats within a league are real: weekly and
   monthly awards, or a Silver Slugger won at two positions. */
function groupAwardYears(awards) {
  const byAward = new Map();
  awards.forEach((a) => {
    let years = byAward.get(a.awardID);
    if (!years) { years = new Map(); byAward.set(a.awardID, years); }
    let leagues = years.get(a.yearID);
    if (!leagues) { leagues = new Map(); years.set(a.yearID, leagues); }
    const lg = a.lgID || '';
    leagues.set(lg, (leagues.get(lg) || 0) + 1);
  });
  const out = new Map();
  byAward.forEach((years, award) => {
    const counts = new Map();
    years.forEach((leagues, year) => {
      let most = 0;
      leagues.forEach((n) => { if (n > most) most = n; });
      counts.set(year, most);
    });
    out.set(award, counts);
  });
  return out;
}

function countByYear(years) {
  const counts = new Map();
  years.forEach((y) => counts.set(y, (counts.get(y) || 0) + 1));
  return counts;
}

function sumCounts(counts) {
  let total = 0;
  counts.forEach((n) => { total += n; });
  return total;
}

/* "1957, 1958, 1959 (2)" — the suffix marks years with more than one. */
function yearList(counts) {
  return Array.from(counts.keys()).sort((a, b) => a - b)
    .map((y) => (counts.get(y) > 1 ? `${y} (${counts.get(y)})` : `${y}`))
    .join(', ');
}

/* Lahman's POS codes. OF is deliberately generic — the LF/CF/RF split lives
   in FieldingOF, which this app does not read. */
const POS_NAMES = {
  P: 'Pitcher', C: 'Catcher', '1B': 'First Base', '2B': 'Second Base',
  '3B': 'Third Base', SS: 'Shortstop', OF: 'Outfield',
  PH: 'Pinch Hitter', PR: 'Pinch Runner',
};

/* ---------------------------------------------------------- formatting */
function fmtRate3(v) { // .342
  if (v == null) return '—';
  return v.toFixed(3).replace(/^0\./, '.');
}
function fmt2(v) { return v == null ? '—' : v.toFixed(2); }
function fmtInt(v) { return v == null ? '0' : String(v); }
function fmtIP(v) { return v == null ? '—' : v.toFixed(1); }

function fmtStat(stat, v) {
  if (v == null) return '—';
  if (['AVG', 'OBP', 'SLG', 'OPS'].includes(stat)) return fmtRate3(v);
  if (['ERA', 'WHIP'].includes(stat)) return fmt2(v);
  if (stat === 'IP') return fmtIP(v);
  return fmtInt(Math.round(v));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function playerLink(id, name) {
  return `<a class="player-link" href="#player/${esc(id)}">${esc(name)}</a>`;
}

function table(headers, rows, opts = {}) {
  const ths = headers.map((h, i) =>
    `<th${opts.txtCols && opts.txtCols.includes(i) ? ' class="txt"' : ''}>${h}</th>`).join('');
  const trs = rows.map((r) => {
    if (r.__section) {
      return `<tr class="section"><td class="txt" colspan="${headers.length}">${r.__section}</td></tr>`;
    }
    const cls = r.__totals ? ' class="totals"' : '';
    const tds = r.cells.map((c, i) =>
      `<td${opts.txtCols && opts.txtCols.includes(i) ? ' class="txt"' : ''}>${c}</td>`).join('');
    return `<tr${cls}>${tds}</tr>`;
  }).join('');
  const cls = opts.cls ? ' class="' + opts.cls + '"' : '';
  return `<div class="table-wrap"><table${cls}><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

async function api(path) {
  if (window.LocalAPI) return window.LocalAPI.handle(path); // serverless build
  const res = await fetch('/api/' + path);
  if (!res.ok) throw new Error('API error ' + res.status);
  return res.json();
}

/* Identity, shown on the About page. APP_BUILD is stamped by build_site.py
   for the published site and stays "dev" when app.py serves static/ directly,
   so a bug report can say which copy it came from — the service worker caches
   the app on-device, and a tester may be running an older bundle than the one
   that is live. */
const APP_NAME = 'Baseball Records';
const APP_VERSION = '1.0 beta';
const APP_BUILD = 'e471289e373d';

/* ---------------------------------------------------------- routing */
const TABS = ['players', 'teams', 'franchises', 'leaders', 'about'];

/* Seasons opens the app: standings and a dashboard of every league's leaders
   give something to read straight away, where the search box gives an empty
   field and no hint of what is behind it. */
const HOME_TAB = 'teams';

function route() {
  const hash = location.hash.slice(1) || HOME_TAB;
  const parts = hash.split('/');
  let tab = parts[0];
  if (tab === 'player') tab = 'players';
  if (tab === 'team') tab = 'teams';
  if (tab === 'franchise') tab = 'franchises';
  if (tab === 'season' || tab === 'range') tab = 'leaders';  // pre-merge links
  if (!TABS.includes(tab)) tab = HOME_TAB;
  TABS.forEach((t) => {
    $('#tab-' + t).classList.toggle('active', t === tab);
  });
  document.querySelectorAll('nav#tabs a').forEach((a) =>
    a.classList.toggle('active', a.dataset.tab === tab));

  if (parts[0] === 'player' && parts[1]) showPlayer(parts[1]);
  if (parts[0] === 'team' && parts[2]) showRoster(+parts[1], parts[2]);
  if (parts[0] === 'franchise' && parts[1]) showFranchise(parts[1]);
  if (parts[0] === 'teams' && parts[1]) showSeason(+parts[1]);
  if (parts[0] === 'franchises') showFranchiseList();
  if (parts[0] === 'about') showAbout();
  // #leaders/<year>/<cat>/<stat> — where the season dashboard tiles point
  if (parts[0] === 'leaders' && parts[1]) openLeaders(+parts[1], parts[2], parts[3]);
  window.scrollTo(0, 0);
}

function openLeaders(year, cat, stat) {
  if (!META || !(year >= META.minYear && year <= META.maxYear)) return;
  const c = cat === 'pitching' ? 'pitching' : 'batting';
  const stats = c === 'pitching' ? META.pitchingStats : META.battingStats;
  const s = stat in stats ? stat : (c === 'pitching' ? 'W' : 'HR');
  $('#lead-mode').value = 'year';
  $('#lead-year').value = year;
  $('#lead-cat').value = c;
  fillStats($('#lead-stat'), c, s);
  $('#lead-stat').value = s;   // set it outright, not via the selected attribute
  syncLeaderControls();
  runLeaders();
}

/* ---------------------------------------------------------- players tab */
let searchTimer = null;

function initPlayers() {
  $('#player-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) { $('#player-results').innerHTML = ''; return; }
    searchTimer = setTimeout(() => doSearch(q), 250);
  });
}

async function doSearch(q) {
  const data = await api('search?q=' + encodeURIComponent(q));
  const el = $('#player-results');
  if (!data.players.length) {
    el.innerHTML = '<p class="note">No players found.</p>';
    return;
  }
  el.innerHTML = '<div class="result-list">' + data.players.map((p) => `
    <div class="result-item" onclick="location.hash='player/${esc(p.playerID)}'">
      <span><strong>${esc(p.name)}</strong></span>
      <span class="meta">${p.debut || p.finalGame
        ? `${esc(p.debut)}–${esc(p.finalGame)} · ${p.careerG} G`
        : 'no playing record'}</span>
    </div>`).join('') + '</div>';
}

async function showPlayer(pid) {
  const el = $('#player-detail');
  $('#player-results').innerHTML = '';
  el.innerHTML = '<p class="loading">Loading player…</p>';
  const d = await api('player/' + encodeURIComponent(pid));
  if (d.error) { el.innerHTML = `<p class="note">${esc(d.error)}</p>`; return; }
  const b = d.bio;
  const name = `${b.nameFirst || ''} ${b.nameLast || ''}`;
  const born = b.birthYear
    ? `Born ${b.birthYear}${b.birthCity ? ', ' + b.birthCity : ''}${b.birthState ? ', ' + b.birthState : ''}${b.birthCountry && b.birthCountry !== 'USA' ? ', ' + b.birthCountry : ''}`
    : '';
  const ht = b.height ? `${Math.floor(b.height / 12)}'${b.height % 12}"` : '';
  const badges = [];
  if (d.hof) badges.push(`<span class="badge hof">Hall of Fame ${d.hof.yearid}</span>`);
  if (d.allstar.length) badges.push(`<span class="badge">${d.allstar.length}× All-Star</span>`);
  const awardCounts = {};
  d.awards.forEach((a) => { awardCounts[a.awardID] = (awardCounts[a.awardID] || 0) + 1; });
  ['Most Valuable Player', 'Cy Young Award', 'Rookie of the Year', 'Gold Glove', 'Silver Slugger', 'Triple Crown', 'Pitching Triple Crown']
    .forEach((aw) => {
      if (awardCounts[aw]) {
        const n = awardCounts[aw];
        badges.push(`<span class="badge ws">${n > 1 ? n + '× ' : ''}${esc(aw)}</span>`);
      }
    });

  let html = `
    <div class="bio-card">
      <h2>${esc(name)}</h2>
      <p class="bio-line">
        ${born ? esc(born) + ' · ' : ''}
        Bats ${esc(b.bats || '?')} / Throws ${esc(b.throws || '?')}
        ${ht ? ' · ' + ht : ''}${b.weight ? ' · ' + b.weight + ' lbs' : ''}
        ${b.debut ? ' · Debut ' + esc(b.debut.slice(0, 10)) : ''}
        ${b.finalGame ? ' · Final game ' + esc(b.finalGame.slice(0, 10)) : ''}
      </p>
      <div class="badges">${badges.join('')}</div>
    </div>`;

  let battingHtml = '';
  let pitchingHtml = '';

  if (d.batting.length) {
    battingHtml += '<h3>Batting</h3>';
    const rows = d.batting.map((s) => ({ cells: [
      yearCell(s.yearID), teamCell(s.teamID, s.yearID), s.lgID || '',
      fmtInt(s.G), fmtInt(s.AB), fmtInt(s.R), fmtInt(s.H), fmtInt(s.D2),
      fmtInt(s.D3), fmtInt(s.HR), fmtInt(s.RBI), fmtInt(s.SB), fmtInt(s.BB),
      fmtInt(s.SO), fmtRate3(s.AVG), fmtRate3(s.OBP), fmtRate3(s.SLG), fmtRate3(s.OPS),
    ]}));
    const t = d.battingTotals;
    if (t) rows.push({ __totals: true, cells: [
      `${t.years} yrs`, '', '',
      fmtInt(t.G), fmtInt(t.AB), fmtInt(t.R), fmtInt(t.H), fmtInt(t.D2),
      fmtInt(t.D3), fmtInt(t.HR), fmtInt(t.RBI), fmtInt(t.SB), fmtInt(t.BB),
      fmtInt(t.SO), fmtRate3(t.AVG), fmtRate3(t.OBP), fmtRate3(t.SLG), fmtRate3(t.OPS),
    ]});
    battingHtml += table(
      ['Year', 'Team', 'Lg', 'G', 'AB', 'R', 'H', '2B', '3B', 'HR', 'RBI', 'SB', 'BB', 'SO', 'AVG', 'OBP', 'SLG', 'OPS'],
      rows, { txtCols: [0, 1, 2] });
  }

  if (d.pitching.length) {
    pitchingHtml += '<h3>Pitching</h3>';
    const rows = d.pitching.map((s) => ({ cells: [
      yearCell(s.yearID), teamCell(s.teamID, s.yearID), s.lgID || '',
      fmtInt(s.W), fmtInt(s.L), fmt2(s.ERA), fmtInt(s.G), fmtInt(s.GS),
      fmtInt(s.CG), fmtInt(s.SHO), fmtInt(s.SV), fmtIP(s.IP), fmtInt(s.H),
      fmtInt(s.BB), fmtInt(s.SO), fmt2(s.WHIP),
    ]}));
    const t = d.pitchingTotals;
    if (t) rows.push({ __totals: true, cells: [
      `${t.years} yrs`, '', '',
      fmtInt(t.W), fmtInt(t.L), fmt2(t.ERA), fmtInt(t.G), fmtInt(t.GS),
      fmtInt(t.CG), fmtInt(t.SHO), fmtInt(t.SV), fmtIP(t.IP), fmtInt(t.H),
      fmtInt(t.BB), fmtInt(t.SO), fmt2(t.WHIP),
    ]});
    pitchingHtml += table(
      ['Year', 'Team', 'Lg', 'W', 'L', 'ERA', 'G', 'GS', 'CG', 'SHO', 'SV', 'IP', 'H', 'BB', 'SO', 'WHIP'],
      rows, { txtCols: [0, 1, 2] });
  }

  // Pitchers lead with pitching; position players lead with batting.
  html += isPrimaryPitcher(d) ? pitchingHtml + battingHtml
    : battingHtml + pitchingHtml;

  // Only worth showing when he actually moved: for the ~63% who played one
  // position their whole career the run list just restates the table below.
  if (d.positions && d.positions.length > 1) {
    html += '<h3>Positions</h3><p class="pos-arc">' + d.positions.map((p) => {
      const span = p.firstYear === p.lastYear ? `${p.firstYear}`
        : `${p.firstYear}–${p.lastYear}`;
      return `<span class="pos-run"><b title="${esc(POS_NAMES[p.POS] || p.POS)}">${esc(p.POS)}</b> ${span}</span>`;
    }).join('<span class="pos-sep">→</span>') + '</p>';
  }

  if (d.fielding.length) {
    html += '<h3>Fielding (career, by position)</h3>';
    html += table(['POS', 'Years', 'G', 'PO', 'A', 'E', 'DP'],
      d.fielding.map((f) => ({ cells: [
        esc(f.POS), fmtInt(f.years), fmtInt(f.G), fmtInt(f.PO), fmtInt(f.A),
        fmtInt(f.E), fmtInt(f.DP)] })),
      { txtCols: [0] });
  }

  const major = d.awards.filter((a) => MAJOR_AWARDS.has(a.awardID));
  const minor = d.awards.filter((a) => !MAJOR_AWARDS.has(a.awardID));

  if (d.allstar.length || d.awards.length) {
    html += '<h3>Awards &amp; Honors</h3>';
    // one row per honor: name, how many times, and the years
    const rows = [];
    if (d.allstar.length) {
      // two All-Star games were played each year from 1959 to 1962
      const counts = countByYear(d.allstar);
      rows.push({ cells: [
        'MLB All-Star', `${d.allstar.length}×`, yearList(counts)] });
    }
    Array.from(groupAwardYears(major).entries())
      .sort((x, y) => MAJOR_AWARD_ORDER.indexOf(x[0]) - MAJOR_AWARD_ORDER.indexOf(y[0]))
      .forEach(([award, counts]) => rows.push({ cells: [
        esc(award), `${sumCounts(counts)}×`, yearList(counts)] }));
    if (rows.length) {
      html += table(['Honor', 'Times', 'Years'], rows, { txtCols: [0, 2] });
    } else {
      html += '<p class="note">No major awards.</p>';
    }
    if (minor.length) {
      // press, All-MLB team, and weekly/monthly honors
      const g = groupAwardYears(minor);
      const otherRows = Array.from(g.entries())
        .map(([award, counts]) => [award, counts, sumCounts(counts)])
        .sort((x, y) => y[2] - x[2] || x[0].localeCompare(y[0]))
        .map(([award, counts, total]) => ({ cells: [
          esc(award), `${total}×`, yearList(counts)] }));
      html += `<details class="more-awards">
        <summary>Other selections &amp; monthly awards (${g.size} types)</summary>
        ${table(['Award', 'Times', 'Years'], otherRows, { txtCols: [0, 2] })}
      </details>`;
    }
  }
  // People carries managers, coaches and others who never played; without
  // this their page is a bio that simply stops.
  if (!d.batting.length && !d.pitching.length && !d.fielding.length) {
    html += '<p class="note">No playing statistics recorded for this person.</p>';
  }

  el.innerHTML = html;
}

/* True when pitching was the player's main role, so his pitching line
   should lead. Compares games pitched with games he appeared as a batter:
   a full-time pitcher's two counts are nearly equal, while a position
   player who took the mound a few times has a tiny share. */
function isPrimaryPitcher(d) {
  const pitG = (d.pitchingTotals && d.pitchingTotals.G) || 0;
  if (!pitG) return false;
  const batG = (d.battingTotals && d.battingTotals.G) || 0;
  if (!batG) return true;
  return pitG / batG >= 0.5;
}

function teamCell(teamID, yearID) {
  return `<a class="team-link" href="#team/${yearID}/${esc(teamID)}">${esc(teamID)}</a>`;
}

/* The season a line belongs to, opening the Seasons tab on it — standings,
   postseason and that year's league leaders. The team cell beside it goes to
   the roster instead, so a career line reaches both. */
function yearCell(yearID) {
  return `<a class="team-link" href="#teams/${yearID}">${yearID}</a>`;
}

/* ---------------------------------------------------------- teams tab */
function initTeams() {
  const sel = $('#team-year');
  fillYears(sel, META.maxYear);
  sel.addEventListener('change', () => {
    $('#team-roster').innerHTML = '';
    showTeams(+sel.value);
  });
  showTeams(+sel.value);
}

const DIV_ORDER = { E: 0, C: 1, W: 2 };
const DIV_NAMES = { E: 'East', C: 'Central', W: 'West' };

/* Postseason rounds: [order played, display name]. Order runs from the
   first round to the final, so the table reads like a bracket. */
const ROUND_INFO = {
  ALWC: [1, 'AL Wild Card'], ALWC1: [1, 'AL Wild Card'],
  ALWC2: [1, 'AL Wild Card'], ALWC3: [1, 'AL Wild Card'],
  ALWC4: [1, 'AL Wild Card'],
  NLWC: [1, 'NL Wild Card'], NLWC1: [1, 'NL Wild Card'],
  NLWC2: [1, 'NL Wild Card'], NLWC3: [1, 'NL Wild Card'],
  NLWC4: [1, 'NL Wild Card'],
  ALDS1: [2, 'AL Division Series'], ALDS2: [2, 'AL Division Series'],
  NLDS1: [2, 'NL Division Series'], NLDS2: [2, 'NL Division Series'],
  AEDIV: [2, 'AL East Division Series'], AWDIV: [2, 'AL West Division Series'],
  NEDIV: [2, 'NL East Division Series'], NWDIV: [2, 'NL West Division Series'],
  NLP1: [2, 'Negro NL Playoff'], NLP2: [2, 'Negro NL Playoff'],
  ALCS: [3, 'AL Championship Series'], NLCS: [3, 'NL Championship Series'],
  CS: [3, 'Championship Series'],
  NLC: [3, 'Negro NL Championship'], ALC: [3, 'Negro AL Championship'],
  NNC: [3, 'Negro National Championship'],
  NSC: [3, 'Negro Southern Championship'],
  WS: [4, 'World Series'], NWS: [4, 'Negro World Series'],
};

async function showPostseason(year) {
  const el = $('#postseason');
  const d = await api('postseason?year=' + year);
  if (!d.series.length) {
    el.innerHTML = `<h3>Postseason</h3><p class="note">No postseason series recorded for ${year}.</p>`;
    return;
  }
  const series = d.series.slice().sort((a, b) => {
    const ia = ROUND_INFO[a.round] || [9, a.round];
    const ib = ROUND_INFO[b.round] || [9, b.round];
    return ia[0] - ib[0] || ia[1].localeCompare(ib[1]) ||
      a.round.localeCompare(b.round);
  });
  const teamCellNamed = (id, name) =>
    `<a class="team-link" href="#team/${year}/${esc(id)}">${esc(name || id)}</a>`;
  const rows = series.map((s) => {
    const info = ROUND_INFO[s.round] || [9, s.round];
    const isFinal = info[0] === 4;
    let score = `${s.wins}–${s.losses}`;
    if (s.ties) score += `, ${s.ties} tie${s.ties > 1 ? 's' : ''}`;
    return {
      __totals: isFinal,
      cells: [
        esc(info[1]),
        teamCellNamed(s.teamIDwinner, s.winnerName),
        teamCellNamed(s.teamIDloser, s.loserName),
        score,
      ],
    };
  });
  el.innerHTML = `<h3>Postseason</h3>` +
    table(['Round', 'Winner', 'Defeated', 'Games'], rows, { txtCols: [0, 1, 2] });
}

function showSeason(year) {
  if (!META || !(year >= META.minYear && year <= META.maxYear)) return;
  $('#team-year').value = year;
  $('#team-roster').innerHTML = '';
  showTeams(year);
}

/* Season dashboard: each league's Triple Crown leaders, above the standings.
   Renames are trivia but leaders are the headline, so this is what the tab
   should open with. Stat names deep-link into the Leaders tab for the full
   top 10/25/50. */
async function showSeasonDashboard(year) {
  const el = $('#season-dashboard');
  const d = await api('season_leaders?year=' + year);
  if (!d.leagues.length) { el.innerHTML = ''; return; }
  el.innerHTML = d.leagues.map((lg) => {
    const tiles = lg.tiles.map((t) => {
      let who;
      if (!t.leaders.length) who = '<span class="tile-none">no qualifier</span>';
      else if (t.tied > 2) who = `<span class="tile-tied">${t.tied} tied</span>`;
      else who = t.leaders.map((l) => playerLink(l.playerID, l.name)).join(' / ');
      const team = t.leaders.length === 1
        ? `<span class="tile-team">${esc(t.leaders[0].teamID)}</span>` : '';
      return `<div class="tile">
        <a class="tile-stat" href="#leaders/${year}/${t.cat}/${esc(t.stat)}">${esc(t.label)}</a>
        <div class="tile-value">${t.value == null ? '—' : fmtStat(t.stat, t.value)}</div>
        <div class="tile-who">${who}${team}</div>
      </div>`;
    }).join('');
    return `<div class="dashboard-lg"><h3>${esc(lg.lgID)} leaders
      <span class="note">${lg.games}-game schedule</span></h3>
      <div class="tile-grid">${tiles}</div></div>`;
  }).join('');
}

async function showTeams(year) {
  const el = $('#team-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  $('#postseason').innerHTML = '';
  showSeasonDashboard(year);
  const d = await api('teams?year=' + year);
  if (!d.teams.length) { el.innerHTML = '<p class="note">No teams for ' + year + '.</p>'; return; }
  const groups = {};
  d.teams.forEach((t) => {
    const key = (t.lgID || '?') + '|' + (t.divID || '');
    (groups[key] = groups[key] || []).push(t);
  });
  let html = `<h2>${year} Season</h2>`;
  const keys = Object.keys(groups).sort((a, b) => {
    const [la, da] = a.split('|'), [lb, db] = b.split('|');
    return la.localeCompare(lb) ||
      (DIV_ORDER[da] ?? 9) - (DIV_ORDER[db] ?? 9) || da.localeCompare(db);
  });
  // one table for the whole season so columns line up across every division
  const rows = [];
  keys.forEach((g) => {
    const [lg, div] = g.split('|');
    rows.push({ __section: esc(lg + (div ? ' ' + (DIV_NAMES[div] || div) : '')) });
    groups[g].forEach((t) => rows.push({ cells: [
      `<a class="team-link" href="#team/${year}/${esc(t.teamID)}">${esc(t.name)}</a>`,
      fmtInt(t.W), fmtInt(t.L),
      (t.W + t.L) ? fmtRate3(t.W / (t.W + t.L)) : '—',
      fmtInt(t.R), fmtInt(t.RA),
      t.wonWS ? '<span class="badge ws">WS Champs</span>'
        : (t.wonLg ? '<span class="badge">Pennant</span>' : ''),
    ]}));
  });
  html += table(['Team', 'W', 'L', 'Pct', 'R', 'RA', ''], rows,
    { txtCols: [0, 6], cls: 'standings' });
  el.innerHTML = html;
  showPostseason(year);
}

async function showRoster(year, teamID) {
  $('#team-year').value = year;
  $('#team-list').innerHTML = '';
  $('#postseason').innerHTML = '';
  $('#season-dashboard').innerHTML = '';
  const el = $('#team-roster');
  el.innerHTML = '<p class="loading">Loading roster…</p>';
  const d = await api(`roster?year=${year}&team=${encodeURIComponent(teamID)}`);
  const t = d.team;
  let html = `<h2>${t ? esc(t.name) : esc(teamID)} — ${year}</h2>`;
  if (t) {
    const div = t.divID ? ' ' + (DIV_NAMES[t.divID] || t.divID) : '';
    html += `<p class="note">${esc((t.lgID || '') + div)} · ${t.W}–${t.L},
      finished #${t.Rank} ·
      <a class="team-link" href="#teams/${year}">← ${year} season</a></p>`;
  }
  if (d.batters.length) {
    html += '<h3>Batters</h3>';
    html += table(['Player', 'POS', 'G', 'AB', 'R', 'H', '2B', '3B', 'HR', 'RBI', 'SB', 'BB', 'AVG'],
      d.batters.map((p) => ({ cells: [
        playerLink(p.playerID, p.name), esc(p.POS || ''), fmtInt(p.G), fmtInt(p.AB),
        fmtInt(p.R), fmtInt(p.H), fmtInt(p.D2), fmtInt(p.D3), fmtInt(p.HR),
        fmtInt(p.RBI), fmtInt(p.SB), fmtInt(p.BB), fmtRate3(p.AVG)] })),
      { txtCols: [0, 1] });
  }
  if (d.pitchers.length) {
    html += '<h3>Pitchers</h3>';
    html += table(['Player', 'W', 'L', 'ERA', 'G', 'GS', 'SV', 'IP', 'SO', 'BB'],
      d.pitchers.map((p) => ({ cells: [
        playerLink(p.playerID, p.name), fmtInt(p.W), fmtInt(p.L), fmt2(p.ERA),
        fmtInt(p.G), fmtInt(p.GS), fmtInt(p.SV), fmtIP(p.IP), fmtInt(p.SO),
        fmtInt(p.BB)] })),
      { txtCols: [0] });
  }
  el.innerHTML = html;
}

/* ---------------------------------------------------------- franchises tab */
let FRANCHISES = null;

function initFranchises() {
  $('#franch-scope').addEventListener('change', renderFranchiseList);
  let t = null;
  $('#franch-search').addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(renderFranchiseList, 200);
  });
}

async function showFranchiseList() {
  $('#franch-detail').innerHTML = '';
  if (!FRANCHISES) {
    $('#franch-list').innerHTML = '<p class="loading">Loading franchises…</p>';
    FRANCHISES = (await api('franchises')).franchises;
  }
  renderFranchiseList();
}

/* The listing carries relocations but not renames: moving city changes what
   a franchise is, while a new nickname does not. Every name it ever had is
   one click away on the detail page. */
function renderFranchiseList() {
  const scope = $('#franch-scope').value;
  const term = $('#franch-search').value.trim().toLowerCase();
  let list = FRANCHISES.filter((f) => scope === 'all' || f.active === scope);
  if (term) {
    list = list.filter((f) =>
      f.name.toLowerCase().includes(term) ||
      f.former.some((c) => c.toLowerCase().includes(term)));
  }
  const el = $('#franch-list');
  if (!list.length) {
    el.innerHTML = '<h2>Franchises</h2><p class="note">No franchises match.</p>';
    return;
  }
  const rows = list.map((f) => {
    const span = f.firstYear === f.lastYear ? `${f.firstYear}`
      : `${f.firstYear}–${f.lastYear}`;
    const pct = (f.W + f.L) ? fmtRate3(f.W / (f.W + f.L)) : '—';
    const badges = [];
    if (f.titles) badges.push(`<span class="badge ws">${f.titles}× WS</span>`);
    else if (f.pennants) badges.push(`<span class="badge">${f.pennants}× Pennant</span>`);
    return { cells: [
      `<a class="team-link" href="#franchise/${esc(f.franchID)}">${esc(f.name)}</a>` +
        (f.former.length
          ? `<span class="former">formerly ${esc(f.former.join(', '))}</span>`
          : ''),
      span, fmtInt(f.seasons), fmtInt(f.W), fmtInt(f.L), pct, badges.join(''),
    ]};
  });
  const moved = list.filter((f) => f.former.length).length;
  el.innerHTML = '<h2>Franchises</h2>' +
    table(['Franchise', 'Span', 'Seasons', 'W', 'L', 'Pct', ''], rows,
      { txtCols: [0, 1, 6], cls: 'standings' }) +
    `<p class="note">${list.length} franchise${list.length > 1 ? 's' : ''}` +
    (moved ? ` · ${moved} played in more than one city` : '') + '.</p>';
}

async function showFranchise(fid) {
  $('#franch-list').innerHTML = '';
  const el = $('#franch-detail');
  el.innerHTML = '<p class="loading">Loading franchise…</p>';
  const d = await api('franchise/' + encodeURIComponent(fid));
  if (d.error) { el.innerHTML = `<p class="note">${esc(d.error)}</p>`; return; }
  const f = d.franchise;
  const span = f.firstYear === f.lastYear ? `${f.firstYear}`
    : `${f.firstYear}–${f.lastYear}`;
  const pct = (f.W + f.L) ? fmtRate3(f.W / (f.W + f.L)) : '—';

  const badges = [];
  if (f.active === 'Y') badges.push('<span class="badge active">active</span>');
  if (f.titles) badges.push(`<span class="badge ws">${f.titles}× World Series</span>`);
  if (f.pennants) badges.push(`<span class="badge">${f.pennants}× Pennant</span>`);

  let html = `
    <div class="bio-card">
      <h2>${esc(f.name)}</h2>
      <p class="bio-line">${span} · ${f.seasons} seasons ·
        ${fmtInt(f.W)}–${fmtInt(f.L)} (${pct}) ·
        ${f.nameCount} name${f.nameCount > 1 ? 's' : ''}</p>
      <div class="badges">${badges.join('')}</div>
      <p class="note"><a class="team-link" href="#franchises">← all franchises</a></p>
    </div>`;

  if (d.locations.length) {
    html += '<h3>Where it played</h3>';
    html += table(['City', 'From', 'To', 'Seasons'],
      d.locations.map((l) => ({ cells: [
        esc(l.location), l.firstYear, l.lastYear,
        fmtInt(l.lastYear - l.firstYear + 1)] })),
      { txtCols: [0, 1, 2] });
  }

  html += '<h3>What it was called</h3>';
  html += table(['Name', 'From', 'To', 'Lg'],
    d.eras.map((e) => ({ cells: [
      esc(e.name), e.firstYear, e.lastYear, esc(e.lgID || '')] })),
    { txtCols: [0, 1, 2, 3] });

  if (d.seasons.length) {
    html += '<h3>Season by season</h3>';
    html += table(['Year', 'Team', 'Lg', 'W', 'L', 'Pct', 'Finish', ''],
      d.seasons.slice().reverse().map((s) => ({ cells: [
        `<a class="team-link" href="#team/${s.yearID}/${esc(s.teamID)}">${s.yearID}</a>`,
        esc(s.name), esc((s.lgID || '') + (s.divID ? ' ' + s.divID : '')),
        fmtInt(s.W), fmtInt(s.L),
        (s.W + s.L) ? fmtRate3(s.W / (s.W + s.L)) : '—',
        s.Rank ? '#' + s.Rank : '—',
        s.wonWS ? '<span class="badge ws">WS Champs</span>'
          : (s.wonLg ? '<span class="badge">Pennant</span>' : ''),
      ]})),
      { txtCols: [0, 1, 2, 6, 7] });
  }
  el.innerHTML = html;
}

/* Season spans are asked in eras, not year pairs. "All time" is every year in
   the data; the other two take their conventional names and openings — the
   modern era from the American League's founding in 1901, the divisional era
   from the 1969 expansion and split into divisions. Each label carries its
   year so the span is explicit rather than assumed.

   Custom keeps the From/To pickers reachable: without it "best home run
   seasons of the 1990s" would no longer be askable. */
const LEAD_ERAS = [
  { id: 'all', label: 'All time', from: null },
  { id: 'modern', label: 'Modern 1901–', from: 1901 },
  { id: 'divisional', label: 'Divisional 1969–', from: 1969 },
  { id: 'custom', label: 'Custom', from: null },
];
let leadEra = 'all';

function eraRange() {
  const e = LEAD_ERAS.find((x) => x.id === leadEra);
  return { start: e && e.from ? e.from : META.minYear, end: META.maxYear };
}

function initEras() {
  $('#lead-era').innerHTML = LEAD_ERAS.map((e) =>
    `<button type="button" data-era="${e.id}"${e.id === leadEra ? ' class="on"' : ''}>${esc(e.label)}</button>`).join('');
  $('#lead-era').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-era]');
    if (!b) return;
    leadEra = b.dataset.era;
    Array.from($('#lead-era').children).forEach((c) =>
      c.classList.toggle('on', c.dataset.era === leadEra));
    syncLeaderControls();
    runLeaders();
  });
}

/* ---------------------------------------------------------- leaders tabs */
function fillYears(sel, selected) {
  const opts = [];
  for (let y = META.maxYear; y >= META.minYear; y--) {
    opts.push(`<option${y === selected ? ' selected' : ''}>${y}</option>`);
  }
  sel.innerHTML = opts.join('');
}

function fillStats(sel, cat, selected) {
  const stats = cat === 'pitching' ? META.pitchingStats : META.battingStats;
  sel.innerHTML = Object.entries(stats).map(([k, label]) =>
    `<option value="${k}"${k === selected ? ' selected' : ''}>${label} (${k})</option>`).join('');
}

function initLeaders() {
  fillYears($('#lead-year'), META.maxYear);
  fillYears($('#lead-start'), 1990);
  fillYears($('#lead-end'), 1999);
  fillStats($('#lead-stat'), 'batting', 'HR');
  initEras();
  $('#lead-cat').addEventListener('change', () =>
    fillStats($('#lead-stat'), $('#lead-cat').value,
      $('#lead-cat').value === 'pitching' ? 'W' : 'HR'));
  $('#lead-mode').addEventListener('change', () => {
    syncLeaderControls();
    runLeaders();
  });
  $('#lead-go').addEventListener('click', runLeaders);
  syncLeaderControls();
  runLeaders();
}

/* Show only the year pickers the current span needs. */
let lastLeaderMode = null;

function syncLeaderControls() {
  const mode = $('#lead-mode').value;
  // Season picks an era; Multi-Year still takes an explicit year pair, and
  // Season falls back to the same pair when its era is Custom.
  const pair = mode === 'multi' || (mode === 'season' && leadEra === 'custom');
  // the detail row disappears entirely for Career, which needs nothing
  $('#lead-span-detail').style.display = mode === 'career' ? 'none' : '';
  $('#lead-year-wrap').style.display = mode === 'year' ? '' : 'none';
  $('#lead-era-wrap').style.display = mode === 'season' ? '' : 'none';
  $('#lead-start-wrap').style.display = pair ? '' : 'none';
  $('#lead-end-wrap').style.display = pair ? '' : 'none';
  if (mode === 'season' && leadEra === 'custom' && lastLeaderMode !== 'season') {
    $('#lead-start').value = META.minYear;
    $('#lead-end').value = META.maxYear;
  }
  lastLeaderMode = mode;
}

async function runLeaders() {
  const mode = $('#lead-mode').value;
  const cat = $('#lead-cat').value;
  const stat = $('#lead-stat').value;
  const limit = $('#lead-limit').value;
  const el = $('#lead-results');
  const note = $('#lead-note');
  const label = (cat === 'pitching' ? META.pitchingStats : META.battingStats)[stat];
  const isRate = META.rateStats.includes(stat);

  let path, heading, qualNote;
  if (mode === 'year') {
    const year = $('#lead-year').value;
    path = `leaders?year=${year}&stat=${stat}&cat=${cat}&limit=${limit}`;
    heading = `${year} ${label} Leaders`;
    qualNote = 'Rate stats require qualifying playing time (≈3.1 plate appearances or 1 inning pitched per team game).';
  } else if (mode === 'season') {
    let start, end, suffix;
    if (leadEra === 'custom') {
      start = $('#lead-start').value; end = $('#lead-end').value;
      if (+end < +start) {
        note.innerHTML = `<span class="warn">⚠ The ending year (${esc(end)}) is before the starting year (${esc(start)}) — please swap them.</span>`;
        el.innerHTML = '';
        return;
      }
      suffix = `, ${start}–${end}`;
    } else {
      const r = eraRange();
      start = r.start; end = r.end;
      suffix = leadEra === 'all' ? ''
        : ` (${LEAD_ERAS.find((x) => x.id === leadEra).label})`;
    }
    path = `best_seasons?start=${start}&end=${end}&stat=${stat}&cat=${cat}&limit=${limit}`;
    heading = `Best Seasons: ${label}${suffix}`;
    qualNote = 'Rate stats require qualifying playing time in that season (≈3.1 plate appearances or 1 inning pitched per game the player\'s league played).';
  } else if (mode === 'multi') {
    const start = $('#lead-start').value, end = $('#lead-end').value;
    if (+end < +start) {
      note.innerHTML = `<span class="warn">⚠ The ending year (${esc(end)}) is before the starting year (${esc(start)}) — please swap them.</span>`;
      el.innerHTML = '';
      return;
    }
    path = `leaders_range?start=${start}&end=${end}&stat=${stat}&cat=${cat}&limit=${limit}`;
    heading = `${label} Leaders, ${start}–${end}`;
    qualNote = 'Rate stats require minimum playing time over the span (400 plate appearances or 130 innings pitched per year, capped at 3,000 PA / 1,000 IP).';
  } else {
    path = `leaders_range?start=${META.minYear}&end=${META.maxYear}&stat=${stat}&cat=${cat}&limit=${limit}`;
    heading = `Career ${label} Leaders`;
    qualNote = 'Rate stats require a full career of playing time (3,000 plate appearances or 1,000 innings pitched).';
  }

  note.innerHTML = isRate ? qualNote : '';
  el.innerHTML = '<p class="loading">Crunching…</p>';
  const d = await api(path);

  let html = `<h2>${esc(heading)}</h2>`;
  if (!d.leaders.length) {
    // rate stats in a thin season can leave nobody over the qualifier
    el.innerHTML = html + `<p class="note">No qualifying players${isRate
      ? ' — nobody reached the minimum playing time that season.' : '.'}</p>`;
    return;
  }
  if (mode === 'season') {
    // one row per player-season, so the year carries the meaning here
    html += table(['#', 'Player', 'Year', 'Team', label],
      d.leaders.map((r, i) => ({ cells: [
        `<span class="rank-num">${i + 1}</span>`,
        playerLink(r.playerID, r.name),
        `<a class="team-link" href="#leaders/${r.yearID}/${cat}/${esc(stat)}">${r.yearID}</a>`,
        r.nteams > 1 ? `${r.nteams} teams` : teamCell(r.teamID, r.yearID),
        `<strong>${fmtStat(stat, r.value)}</strong>`] })),
      { txtCols: [1, 2, 3] });
  } else if (mode === 'year') {
    html += table(['#', 'Player', 'Team', label],
      d.leaders.map((r, i) => ({ cells: [
        `<span class="rank-num">${i + 1}</span>`,
        playerLink(r.playerID, r.name),
        r.nteams > 1 ? `${r.nteams} teams` : teamCell(r.teamID, r.yearID),
        `<strong>${fmtStat(stat, r.value)}</strong>`] })),
      { txtCols: [1, 2] });
  } else {
    // a career reaching the latest season in the data is still going
    const active = d.leaders.filter((r) => r.lastYear === META.maxYear).length;
    html += table(['#', 'Player', 'Seasons', 'Span', label],
      d.leaders.map((r, i) => ({ cells: [
        `<span class="rank-num">${i + 1}</span>`,
        playerLink(r.playerID, r.name) +
          (r.lastYear === META.maxYear ? ' <span class="badge active">active</span>' : ''),
        fmtInt(r.nyears),
        r.firstYear === r.lastYear ? `${r.firstYear}` : `${r.firstYear}–${r.lastYear}`,
        `<strong>${fmtStat(stat, r.value)}</strong>`] })),
      { txtCols: [1, 3] });
    if (active) {
      html += `<p class="note">${active} active player${active > 1 ? 's' : ''}
        — still playing as of the ${META.maxYear} season.</p>`;
    }
  }
  el.innerHTML = html;
}

/* ---------------------------------------------------------- about tab */
/* Reachable from the footer rather than the nav, so browsing keeps the four
   tabs. The attribution here is a licence requirement, not decoration:
   CC BY-SA asks for credit and for changes to be stated. */
function showAbout() {
  const el = $('#about-version');
  if (el && !el.textContent) {
    el.textContent = `${APP_NAME} ${APP_VERSION} · build ${APP_BUILD} · `
      + `seasons ${META.minYear}–${META.maxYear}`;
  }
}

/* ---------------------------------------------------------- boot */
async function boot() {
  META = await api('meta');
  initPlayers();
  initTeams();
  initFranchises();
  initLeaders();
  window.addEventListener('hashchange', route);
  route();
}
boot();
