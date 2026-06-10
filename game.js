'use strict';

/* ================= Config ================= */
const ARENA = 800;            // logical arena size (px)
const STEP = 1 / 60;          // fixed simulation step (s)
const SPEED = 115;            // movement speed (px/s)
const TURN = 3.4;             // turn rate (rad/s)
const LINE_W = 4;             // trail width
const COMMIT_DELAY = 250;     // ms before a trail segment becomes deadly (lets you not hit your own neck)
const MAX_PLAYERS = 8;
const PREFIX = 'curve-clash-7gx-';  // namespaces our room IDs on the public PeerJS broker
const COLORS = ['#ff4d6d', '#4dd2ff', '#ffe34d', '#6dff4d', '#ff9b4d', '#c44dff', '#4dffc4', '#f0f0f0'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// STUN finds the direct path between homes; the free TURN relays below are a
// fallback for strict routers that block direct peer-to-peer connections.
const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ],
  },
};

/* ================= DOM ================= */
const $ = id => document.getElementById(id);
const screens = { menu: $('screen-menu'), lobby: $('screen-lobby'), game: $('screen-game') };
const trailCtx = $('trail').getContext('2d');
const headCtx = $('heads').getContext('2d');
// hidden canvas used by the host for collision detection
const hitCanvas = document.createElement('canvas');
hitCanvas.width = hitCanvas.height = ARENA;
const hitCtx = hitCanvas.getContext('2d', { willReadFrequently: true });

function showScreen(name) {
  for (const k in screens) screens[k].classList.toggle('hidden', k !== name);
}
function setStatus(msg) { $('menu-status').textContent = msg; }
function showOverlay(main, sub) {
  $('overlay-main').textContent = main;
  $('overlay-sub').textContent = sub || '';
  $('overlay').classList.remove('hidden');
}
function hideOverlay() { $('overlay').classList.add('hidden'); }

/* ================= Shared state ================= */
let peer = null;        // our PeerJS peer
let hostConn = null;    // client: connection to host
let isHost = false;
let myName = '';
let roomCode = '';
let myIndex = -1;
let phase = 'menu';     // menu | lobby | countdown | playing | roundend | over
let roster = [];        // [{n: name, c: color, s: score, a: alive}] shared by everyone
let lastPos = [];       // per-player last head position {x, y, a} for trail drawing

/* ================= Host-only state ================= */
let hPlayers = [];      // [{conn, isHost, name, color, score, dir, inGame}]
let sim = null;         // {players: [{x, y, angle, alive, gapOn, gapT, pending: []}], running}
let target = 10;        // points needed to win
let rafId = null, lastTs = 0, acc = 0;
let cdToken = 0;        // invalidates pending countdown timers

const rand = (a, b) => a + Math.random() * (b - a);

/* ================= Menu / connection ================= */
function getName() {
  const n = $('name-input').value.trim().slice(0, 12) || 'Player';
  localStorage.setItem('cc-name', n);
  return n;
}

function genCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

function createGame() {
  myName = getName();
  setStatus('Creating room…');
  tryHost(0);
}

function tryHost(attempt) {
  roomCode = genCode();
  peer = new Peer(PREFIX + roomCode, PEER_OPTS);
  peer.on('open', () => {
    isHost = true;
    myIndex = 0;
    hPlayers = [{ conn: null, isHost: true, name: myName, color: COLORS[0], score: 0, dir: 0, inGame: false }];
    setStatus('');
    broadcastLobby(false);
  });
  peer.on('error', e => {
    if (e.type === 'unavailable-id' && attempt < 5) {
      peer.destroy();
      tryHost(attempt + 1);
    } else if (!isHost) {
      setStatus('Connection error: ' + e.type);
    }
  });
  peer.on('disconnected', () => { try { peer.reconnect(); } catch (_) {} });
  peer.on('connection', conn => {
    conn.on('data', m => onClientData(conn, m));
    conn.on('close', () => onClientLeave(conn));
    conn.on('error', () => onClientLeave(conn));
  });
}

function joinGame() {
  const code = $('code-input').value.trim().toUpperCase();
  if (code.length !== 4) { setStatus('Enter the 4-letter room code.'); return; }
  myName = getName();
  roomCode = code;
  setStatus('Connecting…');
  peer = new Peer(PEER_OPTS);
  peer.on('open', () => {
    hostConn = peer.connect(PREFIX + code, { reliable: true });
    hostConn.on('open', () => hostConn.send({ t: 'hello', n: myName }));
    hostConn.on('data', clientHandle);
    hostConn.on('close', () => { if (phase !== 'menu') fatal('Disconnected from host.'); });
  });
  peer.on('error', e => {
    if (e.type === 'peer-unavailable') { setStatus('Room not found. Check the code.'); cleanup(); }
    else if (phase === 'menu') setStatus('Connection error: ' + e.type);
  });
  peer.on('disconnected', () => { try { peer.reconnect(); } catch (_) {} });
}

function fatal(msg) {
  cleanup();
  showScreen('menu');
  setStatus(msg);
}

function cleanup() {
  cdToken++;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  if (peer) { try { peer.destroy(); } catch (_) {} }
  peer = null; hostConn = null; isHost = false; sim = null;
  hPlayers = []; roster = []; lastPos = []; myIndex = -1;
  phase = 'menu';
}

/* ================= Host: lobby & players ================= */
function nextColor() {
  const used = hPlayers.map(p => p.color);
  return COLORS.find(c => !used.includes(c)) || COLORS[hPlayers.length % COLORS.length];
}

function lobbyMsg(inProgress) {
  return {
    t: 'lobby',
    code: roomCode,
    roster: hPlayers.map(p => ({ n: p.name, c: p.color, s: p.score, a: false })),
    game: !!inProgress,
  };
}

function broadcastLobby(inProgress) { broadcastAll(lobbyMsg(inProgress)); }

function broadcastAll(msg) {
  for (const p of hPlayers) if (p.conn && p.conn.open) p.conn.send(msg);
  clientHandle(msg); // host consumes its own messages through the same path as clients
}

function broadcastGame(msg) {
  for (const p of hPlayers) if (p.conn && p.conn.open && p.inGame) p.conn.send(msg);
  clientHandle(msg);
}

function onClientData(conn, m) {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'hello') {
    if (hPlayers.some(p => p.conn === conn)) return;
    if (hPlayers.length >= MAX_PLAYERS) { conn.send({ t: 'full' }); return; }
    const name = String(m.n || 'Player').trim().slice(0, 12) || 'Player';
    hPlayers.push({ conn, isHost: false, name, color: nextColor(), score: 0, dir: 0, inGame: false });
    conn.send({ t: 'you', i: hPlayers.length - 1 });
    if (phase === 'lobby') broadcastLobby(false);
    else conn.send(lobbyMsg(true)); // joined mid-game: wait in lobby until next round
  } else if (m.t === 'in') {
    const p = hPlayers.find(p => p.conn === conn);
    if (p) p.dir = m.d === 1 ? 1 : m.d === -1 ? -1 : 0;
  }
}

function onClientLeave(conn) {
  const idx = hPlayers.findIndex(p => p.conn === conn);
  if (idx < 0) return;
  if (phase === 'lobby') {
    hPlayers.splice(idx, 1);
    resendIndices();
    broadcastLobby(false);
  } else {
    // keep the slot until the round ends so indices stay stable; just kill the snake
    if (sim && sim.running && sim.players[idx] && sim.players[idx].alive) killPlayer(idx);
  }
}

function resendIndices() {
  hPlayers.forEach((p, i) => { if (p.conn && p.conn.open) p.conn.send({ t: 'you', i }); });
}

function compactPlayers() {
  hPlayers = hPlayers.filter(p => p.isHost || (p.conn && p.conn.open));
  resendIndices();
}

/* ================= Host: simulation ================= */
function spawnAll(n) {
  const players = [];
  const margin = 120;
  for (let i = 0; i < n; i++) {
    let x, y, ok = false;
    for (let tries = 0; tries < 30 && !ok; tries++) {
      x = rand(margin, ARENA - margin);
      y = rand(margin, ARENA - margin);
      ok = players.every(p => Math.hypot(p.x - x, p.y - y) > 130);
    }
    const angle = Math.atan2(ARENA / 2 - y, ARENA / 2 - x) + rand(-0.8, 0.8);
    players.push({
      x, y, angle, alive: true,
      gapOn: false, gapT: rand(1.8, 3.6),
      pending: [],
    });
  }
  return players;
}

function rosterMsg() {
  return hPlayers.map(p => ({ n: p.name, c: p.color, s: p.score, a: true }));
}

function stateMsg() {
  return {
    t: 's',
    h: sim.players.map(p => [
      +p.x.toFixed(1), +p.y.toFixed(1), p.gapOn ? 1 : 0, p.alive ? 1 : 0,
    ]),
  };
}

function startMatch() {
  target = Math.max(10, (hPlayers.length - 1) * 10);
  startRound();
}

function startRound() {
  compactPlayers();
  if (hPlayers.length === 0) return;
  hPlayers.forEach(p => { p.inGame = true; p.dir = 0; });
  hitCtx.clearRect(0, 0, ARENA, ARENA);
  sim = { players: spawnAll(hPlayers.length), running: false };
  broadcastAll({ t: 'roundStart', roster: rosterMsg(), target });
  broadcastGame(stateMsg());
  const tok = ++cdToken;
  [[0, 3], [800, 2], [1600, 1]].forEach(([d, n]) =>
    setTimeout(() => { if (tok === cdToken) broadcastGame({ t: 'cd', n }); }, d));
  setTimeout(() => {
    if (tok !== cdToken) return;
    broadcastGame({ t: 'go' });
    sim.running = true;
    lastTs = performance.now();
    acc = 0;
    rafId = requestAnimationFrame(loop);
  }, 2400);
}

function loop(ts) {
  if (!sim || !sim.running) { rafId = null; return; }
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  acc += dt;
  const now = performance.now();
  while (acc >= STEP) { stepSim(STEP, now); acc -= STEP; }
  commitPending(now);
  broadcastGame(stateMsg());

  const total = sim.players.length;
  const alive = sim.players.filter(p => p.alive).length;
  if (alive <= (total > 1 ? 1 : 0)) endRound();
  else rafId = requestAnimationFrame(loop);
}

function stepSim(dt, now) {
  for (let i = 0; i < sim.players.length; i++) {
    const p = sim.players[i];
    if (!p.alive) continue;
    const dir = hPlayers[i] ? hPlayers[i].dir : 0;
    p.angle += dir * TURN * dt;

    p.gapT -= dt;
    if (p.gapT <= 0) {
      p.gapOn = !p.gapOn;
      p.gapT = p.gapOn ? rand(0.22, 0.35) : rand(1.8, 3.6);
    }

    const nx = p.x + Math.cos(p.angle) * SPEED * dt;
    const ny = p.y + Math.sin(p.angle) * SPEED * dt;
    p.pending.push({ x1: p.x, y1: p.y, x2: nx, y2: ny, gap: p.gapOn, ts: now });
    p.x = nx; p.y = ny;

    const r = LINE_W / 2 + 1.5;
    let dead = p.x < r || p.y < r || p.x > ARENA - r || p.y > ARENA - r;
    if (!dead) {
      for (const off of [0, -0.7, 0.7]) {
        const sx = (p.x + Math.cos(p.angle + off) * r) | 0;
        const sy = (p.y + Math.sin(p.angle + off) * r) | 0;
        if (hitCtx.getImageData(sx, sy, 1, 1).data[3] > 0) { dead = true; break; }
      }
    }
    if (dead) killPlayer(i);
  }
}

function commitPending(now) {
  hitCtx.lineWidth = LINE_W;
  hitCtx.lineCap = 'round';
  hitCtx.strokeStyle = '#fff';
  for (const p of sim.players) {
    while (p.pending.length && now - p.pending[0].ts > COMMIT_DELAY) {
      const s = p.pending.shift();
      if (!s.gap) {
        hitCtx.beginPath();
        hitCtx.moveTo(s.x1, s.y1);
        hitCtx.lineTo(s.x2, s.y2);
        hitCtx.stroke();
      }
    }
  }
}

function killPlayer(i) {
  const sp = sim.players[i];
  if (!sp || !sp.alive) return;
  sp.alive = false;
  for (let j = 0; j < sim.players.length; j++) {
    if (j !== i && sim.players[j].alive && hPlayers[j]) hPlayers[j].score++;
  }
  broadcastGame({ t: 'die', i, s: hPlayers.map(p => p.score) });
}

function endRound() {
  sim.running = false;
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  const si = sim.players.findIndex(p => p.alive);
  const m = si >= 0 && hPlayers[si] ? `${hPlayers[si].name} survives the round!` : 'Nobody survived!';
  broadcastAll({ t: 'roundEnd', s: hPlayers.map(p => p.score), m });
  setTimeout(() => {
    if (!isHost || phase !== 'roundend') return;
    const best = Math.max(...hPlayers.map(p => p.score));
    if (best >= target) {
      const wi = hPlayers.findIndex(p => p.score === best);
      broadcastAll({ t: 'over', m: `${hPlayers[wi].name} wins the game!` });
      setTimeout(() => {
        if (!isHost || phase !== 'over') return;
        hPlayers.forEach(p => { p.score = 0; p.inGame = false; });
        broadcastLobby(false);
      }, 4500);
    } else {
      startRound();
    }
  }, 3200);
}

/* ================= Client message handling (host uses this too) ================= */
function clientHandle(msg) {
  switch (msg.t) {
    case 'you':
      myIndex = msg.i;
      break;
    case 'full':
      fatal('That room is full (8 players max).');
      break;
    case 'lobby':
      roster = msg.roster;
      roomCode = msg.code;
      phase = 'lobby';
      showScreen('lobby');
      renderLobby(msg.game);
      break;
    case 'roundStart':
      roster = msg.roster;
      lastPos = [];
      trailCtx.clearRect(0, 0, ARENA, ARENA);
      headCtx.clearRect(0, 0, ARENA, ARENA);
      phase = 'countdown';
      showScreen('game');
      renderHud();
      showOverlay('Get ready…', `First to ${msg.target} points wins`);
      break;
    case 'cd':
      showOverlay(String(msg.n), '');
      break;
    case 'go':
      hideOverlay();
      phase = 'playing';
      break;
    case 's':
      applyState(msg.h);
      break;
    case 'die':
      if (roster[msg.i]) roster[msg.i].a = false;
      if (msg.s) msg.s.forEach((v, i) => { if (roster[i]) roster[i].s = v; });
      renderHud();
      break;
    case 'roundEnd':
      msg.s.forEach((v, i) => { if (roster[i]) roster[i].s = v; });
      phase = 'roundend';
      renderHud();
      showOverlay(msg.m, 'Next round soon…');
      break;
    case 'over':
      phase = 'over';
      showOverlay('🏆 ' + msg.m, 'Returning to lobby…');
      break;
  }
}

/* ================= Rendering ================= */
function applyState(h) {
  for (let i = 0; i < h.length; i++) {
    const [x, y, g, a] = h[i];
    const lp = lastPos[i];
    if (lp && !g && (a || lp.a) && (x !== lp.x || y !== lp.y) && roster[i]) {
      trailCtx.strokeStyle = roster[i].c;
      trailCtx.lineWidth = LINE_W;
      trailCtx.lineCap = 'round';
      trailCtx.beginPath();
      trailCtx.moveTo(lp.x, lp.y);
      trailCtx.lineTo(x, y);
      trailCtx.stroke();
    }
    lastPos[i] = { x, y, a };
  }
  headCtx.clearRect(0, 0, ARENA, ARENA);
  for (let i = 0; i < h.length; i++) {
    if (!roster[i]) continue;
    const [x, y, , a] = h[i];
    headCtx.beginPath();
    headCtx.arc(x, y, a ? LINE_W + 1.5 : LINE_W, 0, Math.PI * 2);
    headCtx.fillStyle = a ? '#ffffff' : '#444';
    headCtx.fill();
    if (a) {
      headCtx.beginPath();
      headCtx.arc(x, y, LINE_W - 1, 0, Math.PI * 2);
      headCtx.fillStyle = roster[i].c;
      headCtx.fill();
    }
  }
}

function renderHud() {
  const hud = $('hud');
  hud.innerHTML = '';
  roster.forEach((r, i) => {
    const chip = document.createElement('div');
    chip.className = 'chip' + (r.a ? '' : ' dead');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = r.c;
    const name = document.createElement('span');
    name.textContent = r.n + (i === myIndex ? ' (you)' : '');
    const sc = document.createElement('span');
    sc.className = 'score';
    sc.textContent = r.s;
    chip.append(dot, name, sc);
    hud.append(chip);
  });
}

function renderLobby(gameInProgress) {
  $('lobby-code').textContent = roomCode;
  const list = $('player-list');
  list.innerHTML = '';
  roster.forEach((r, i) => {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = r.c;
    const name = document.createElement('span');
    name.textContent = r.n + (i === myIndex ? ' (you)' : '') + (i === 0 ? ' 👑' : '');
    li.append(dot, name);
    list.append(li);
  });
  $('btn-start').classList.toggle('hidden', !isHost);
  const status = $('lobby-status');
  if (gameInProgress) status.textContent = 'Round in progress — you join the next one!';
  else if (isHost) status.textContent = roster.length < 2 ? 'Share the invite link — you need at least 2 players for a real game.' : '';
  else status.textContent = 'Waiting for the host to start…';
}

/* ================= Input ================= */
let leftDown = false, rightDown = false, curDir = 0;

function updateDir() {
  const d = (rightDown ? 1 : 0) - (leftDown ? 1 : 0);
  if (d === curDir) return;
  curDir = d;
  if (isHost) { if (hPlayers[0]) hPlayers[0].dir = d; }
  else if (hostConn && hostConn.open) hostConn.send({ t: 'in', d });
}

function handleKey(e, down) {
  if (screens.game.classList.contains('hidden')) return;
  let used = true;
  if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') leftDown = down;
  else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') rightDown = down;
  else used = false;
  if (used) { e.preventDefault(); updateDir(); }
}
window.addEventListener('keydown', e => handleKey(e, true));
window.addEventListener('keyup', e => handleKey(e, false));

function bindHold(el, set) {
  const on = e => { e.preventDefault(); set(true); updateDir(); };
  const off = e => { e.preventDefault(); set(false); updateDir(); };
  el.addEventListener('pointerdown', on);
  el.addEventListener('pointerup', off);
  el.addEventListener('pointercancel', off);
  el.addEventListener('pointerleave', off);
  el.addEventListener('contextmenu', e => e.preventDefault());
}
bindHold($('touch-left'), v => { leftDown = v; });
bindHold($('touch-right'), v => { rightDown = v; });

/* ================= UI wiring ================= */
$('btn-create').addEventListener('click', () => { if (!peer) createGame(); });
$('btn-join').addEventListener('click', () => { if (!peer) joinGame(); });
$('code-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !peer) joinGame(); });
$('code-input').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
$('btn-start').addEventListener('click', () => { if (isHost && phase === 'lobby') startMatch(); });
$('btn-copy').addEventListener('click', () => {
  const url = location.origin + location.pathname + '?room=' + roomCode;
  navigator.clipboard.writeText(url).then(() => {
    $('btn-copy').textContent = 'Link copied!';
    setTimeout(() => { $('btn-copy').textContent = 'Copy invite link'; }, 1500);
  });
});

$('name-input').value = localStorage.getItem('cc-name') || '';
const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  $('code-input').value = roomParam.toUpperCase().slice(0, 4);
  setStatus('Enter your name and hit Join!');
}
