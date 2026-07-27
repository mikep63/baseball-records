/* Baseball Records frontend */
'use strict';

const $ = (sel) => document.querySelector(sel);
let META = null;

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
    const cls = r.__totals ? ' class="totals"' : '';
    const tds = r.cells.map((c, i) =>
      `<td${opts.txtCols && opts.txtCols.includes(i) ? ' class="txt"' : ''}>${c}</td>`).join('');
    return `<tr${cls}>${tds}</tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`;
}

async function api(path) {
  if (window.LocalAPI) return window.LocalAPI.handle(path); // serverless build
  const res = await fetch('/api/' + path);
  if (!res.ok) throw new Error('API error ' + res.status);
  return res.json();
}

/* ---------------------------------------------------------- routing */
const TABS = ['players', 'teams', 'season', 'range'];

function route() {
  const hash = location.hash.slice(1) || 'players';
  const parts = hash.split('/');
  let tab = parts[0];
  if (tab === 'player') tab = 'players';
  if (tab === 'team') tab = 'teams';
  if (!TABS.includes(tab)) tab = 'players';
  TABS.forEach((t) => {
    $('#tab-' + t).classList.toggle('active', t === tab);
  });
  document.querySelectorAll('nav#tabs a').forEach((a) =>
    a.classList.toggle('active', a.dataset.tab === tab));

  if (parts[0] === 'player' && parts[1]) showPlayer(parts[1]);
  if (parts[0] === 'team' && parts[2]) showRoster(+parts[1], parts[2]);
  window.scrollTo(0, 0);
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
      <span class="meta">${esc(p.debut)}–${esc(p.finalGame)} · ${p.careerG} G</span>
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

  if (d.batting.length) {
    html += '<h3>Batting</h3>';
    const rows = d.batting.map((s) => ({ cells: [
      s.yearID, teamCell(s.teamID, s.yearID), s.lgID || '',
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
    html += table(
      ['Year', 'Team', 'Lg', 'G', 'AB', 'R', 'H', '2B', '3B', 'HR', 'RBI', 'SB', 'BB', 'SO', 'AVG', 'OBP', 'SLG', 'OPS'],
      rows, { txtCols: [0, 1, 2] });
  }

  if (d.pitching.length) {
    html += '<h3>Pitching</h3>';
    const rows = d.pitching.map((s) => ({ cells: [
      s.yearID, teamCell(s.teamID, s.yearID), s.lgID || '',
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
    html += table(
      ['Year', 'Team', 'Lg', 'W', 'L', 'ERA', 'G', 'GS', 'CG', 'SHO', 'SV', 'IP', 'H', 'BB', 'SO', 'WHIP'],
      rows, { txtCols: [0, 1, 2] });
  }

  if (d.fielding.length) {
    html += '<h3>Fielding (career, by position)</h3>';
    html += table(['POS', 'Years', 'G', 'PO', 'A', 'E', 'DP'],
      d.fielding.map((f) => ({ cells: [
        esc(f.POS), fmtInt(f.years), fmtInt(f.G), fmtInt(f.PO), fmtInt(f.A),
        fmtInt(f.E), fmtInt(f.DP)] })),
      { txtCols: [0] });
  }

  if (d.awards.length) {
    html += '<h3>Awards</h3>';
    html += table(['Year', 'Award', 'Lg'],
      d.awards.map((a) => ({ cells: [a.yearID, esc(a.awardID), esc(a.lgID || '')] })),
      { txtCols: [1, 2] });
  }
  el.innerHTML = html;
}

function teamCell(teamID, yearID) {
  return `<a class="team-link" href="#team/${yearID}/${esc(teamID)}">${esc(teamID)}</a>`;
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

async function showTeams(year) {
  const el = $('#team-list');
  el.innerHTML = '<p class="loading">Loading…</p>';
  const d = await api('teams?year=' + year);
  if (!d.teams.length) { el.innerHTML = '<p class="note">No teams for ' + year + '.</p>'; return; }
  const groups = {};
  d.teams.forEach((t) => {
    const key = (t.lgID || '?') + (t.divID ? ' ' + t.divID : '');
    (groups[key] = groups[key] || []).push(t);
  });
  let html = `<h2>${year} Teams</h2>`;
  Object.keys(groups).sort().forEach((g) => {
    html += `<div class="team-group"><h3>${esc(g)}</h3>`;
    html += table(['Team', 'W', 'L', 'Pct', 'R', 'RA', ''],
      groups[g].map((t) => ({ cells: [
        `<a class="team-link" href="#team/${year}/${esc(t.teamID)}">${esc(t.name)}</a>`,
        fmtInt(t.W), fmtInt(t.L),
        (t.W + t.L) ? fmtRate3(t.W / (t.W + t.L)) : '—',
        fmtInt(t.R), fmtInt(t.RA),
        t.wonWS ? '<span class="badge ws">WS Champs</span>' : (t.wonLg ? '<span class="badge">Pennant</span>' : ''),
      ]})), { txtCols: [0, 6] });
    html += '</div>';
  });
  el.innerHTML = html;
}

async function showRoster(year, teamID) {
  $('#team-year').value = year;
  $('#team-list').innerHTML = '';
  const el = $('#team-roster');
  el.innerHTML = '<p class="loading">Loading roster…</p>';
  const d = await api(`roster?year=${year}&team=${encodeURIComponent(teamID)}`);
  const t = d.team;
  let html = `<h2>${t ? esc(t.name) : esc(teamID)} — ${year}</h2>`;
  if (t) html += `<p class="note">${esc(t.lgID || '')}${t.divID ? ' ' + esc(t.divID) : ''} · ${t.W}–${t.L}, finished #${t.Rank} · <a class="team-link" href="#teams" onclick="showTeams(${year})">← all ${year} teams</a></p>`;
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

function initSeason() {
  fillYears($('#season-year'), META.maxYear);
  fillStats($('#season-stat'), 'batting', 'HR');
  $('#season-cat').addEventListener('change', () =>
    fillStats($('#season-stat'), $('#season-cat').value, $('#season-cat').value === 'pitching' ? 'W' : 'HR'));
  $('#season-go').addEventListener('click', runSeason);
  runSeason();
}

async function runSeason() {
  const year = $('#season-year').value, cat = $('#season-cat').value,
    stat = $('#season-stat').value, limit = $('#season-limit').value;
  const el = $('#season-results');
  el.innerHTML = '<p class="loading">Loading…</p>';
  const d = await api(`leaders?year=${year}&stat=${stat}&cat=${cat}&limit=${limit}`);
  const label = (cat === 'pitching' ? META.pitchingStats : META.battingStats)[stat];
  let html = `<h2>${year} ${esc(label)} Leaders</h2>`;
  if (META.rateStats.includes(stat)) {
    html += '<p class="note">Rate stats require qualifying playing time (≈3.1 PA or 1 IP per team game).</p>';
  }
  html += table(['#', 'Player', 'Team', label],
    d.leaders.map((r, i) => ({ cells: [
      `<span class="rank-num">${i + 1}</span>`,
      playerLink(r.playerID, r.name),
      r.nteams > 1 ? `${r.nteams} teams` : teamCell(r.teamID, year),
      `<strong>${fmtStat(stat, r.value)}</strong>`] })),
    { txtCols: [1, 2] });
  el.innerHTML = html;
}

function initRange() {
  fillYears($('#range-start'), 1990);
  fillYears($('#range-end'), 1999);
  fillStats($('#range-stat'), 'batting', 'HR');
  $('#range-cat').addEventListener('change', () =>
    fillStats($('#range-stat'), $('#range-cat').value, $('#range-cat').value === 'pitching' ? 'W' : 'HR'));
  $('#range-go').addEventListener('click', runRange);
}

async function runRange() {
  const start = $('#range-start').value, end = $('#range-end').value,
    cat = $('#range-cat').value, stat = $('#range-stat').value,
    limit = $('#range-limit').value;
  const el = $('#range-results');
  const note = $('#range-note');
  if (+end < +start) {
    note.innerHTML = `<span class="warn">⚠ The ending year (${esc(end)}) is before the starting year (${esc(start)}) — please swap them.</span>`;
    el.innerHTML = '';
    return;
  }
  note.textContent = '';
  el.innerHTML = '<p class="loading">Crunching…</p>';
  const d = await api(`leaders_range?start=${start}&end=${end}&stat=${stat}&cat=${cat}&limit=${limit}`);
  const label = (cat === 'pitching' ? META.pitchingStats : META.battingStats)[stat];
  let html = `<h2>${label} Leaders, ${d.start}–${d.end}</h2>`;
  if (META.rateStats.includes(stat)) {
    html += '<p class="note">Rate stats require minimum playing time over the span (400 PA or 130 IP per year, capped at 3000 PA / 1000 IP).</p>';
  }
  html += table(['#', 'Player', 'Seasons', label],
    d.leaders.map((r, i) => ({ cells: [
      `<span class="rank-num">${i + 1}</span>`,
      playerLink(r.playerID, r.name),
      fmtInt(r.nyears),
      `<strong>${fmtStat(stat, r.value)}</strong>`] })),
    { txtCols: [1] });
  el.innerHTML = html;
}

/* ---------------------------------------------------------- boot */
async function boot() {
  META = await api('meta');
  initPlayers();
  initTeams();
  initSeason();
  initRange();
  window.addEventListener('hashchange', route);
  route();
}
boot();
