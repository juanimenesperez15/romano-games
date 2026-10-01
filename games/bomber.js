module.exports = function(io) {

// ── Config ──
var TPS = 60, NET_TPS = 30;
var W = 15, H = 13;                 // grid (odd sizes: classic pillar layout)
var SLOTS = 4;
var COLORS = ['#EF4444', '#3B82F6', '#22C55E', '#F59E0B'];
var SPAWNS = [[1, 1], [W - 2, H - 2], [W - 2, 1], [1, H - 2]];
var BOT_NAMES = ['Bot Cacho', 'Bot Tito', 'Bot Pipo', 'Bot Chacho', 'Bot Rulo', 'Bot Coco'];
var LOBBY_TIME = 20;                // auto start (s) once a human is waiting
var COUNTDOWN = 3;                  // s before each round
var ROUND_END_TIME = 3.5;           // s showing round winner
var MATCH_END_TIME = 7;             // s showing match winner
var WINS_TO_MATCH = 3;
var ROUND_TIME = 100;               // s before sudden death starts
var SD_STEP = 0.35;                 // s between each falling wall in sudden death
var SOFT_DENSITY = 0.72;
var FUSE = 2.6;                     // s
var FLAME_MS = 550;
var BASE_SPEED = 3.3, SPEED_STEP = 0.55, MAX_SPEED = 6;   // tiles / s
var START_BOMBS = 1, MAX_BOMBS = 8, START_RANGE = 2, MAX_RANGE = 8;
var ITEM_CHANCE = 0.38;
var ITEM_TYPES = ['bomb', 'fire', 'speed', 'shield', 'kick'];
var ITEM_WEIGHTS = [34, 32, 18, 8, 8];
var KICK_SPEED = 9;                 // tiles / s
var INVULN_MS = 1500;
var BOT_THINK_MS = 160;

// Tiles
var EMPTY = 0, HARD = 1, SOFT = 2;

// ── State ──
var phase = 'lobby';                // lobby | countdown | playing | roundEnd | matchEnd
var phaseStart = Date.now();
var lobbyStart = 0;
var round = 0;
var players = {};                   // id -> player (humans + bots)
var slots = [null, null, null, null]; // slot -> player id
var grid = [];
var bombs = [];
var bombGrid = [];
var itemGrid = [];
var flameUntil = [];
var flameOwner = [];
var sdOrder = [], sdIndex = 0, sdNext = 0, suddenDeath = false;
var lastResult = null;
var lastHumanKiller = null;      // bot that took out the last human gets the round
var botCounter = 0;

function idx(x, y) { return y * W + x; }
function inside(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
function now() { return Date.now(); }
function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function cleanName(n) { return String(n || 'Jugador').replace(/[<>&"']/g, '').trim().substring(0, 12) || 'Jugador'; }

// ── Map ──
function buildMap() {
  grid = new Array(W * H); bombGrid = new Array(W * H); itemGrid = new Array(W * H); flameUntil = new Array(W * H); flameOwner = new Array(W * H);
  for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
    var i = idx(x, y);
    bombGrid[i] = null; itemGrid[i] = null; flameUntil[i] = 0; flameOwner[i] = null;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || (x % 2 === 0 && y % 2 === 0)) grid[i] = HARD;
    else grid[i] = Math.random() < SOFT_DENSITY ? SOFT : EMPTY;
  }
  // Clear the spawn corners (L shape)
  for (var s = 0; s < SPAWNS.length; s++) {
    var sx = SPAWNS[s][0], sy = SPAWNS[s][1];
    var dx = sx === 1 ? 1 : -1, dy = sy === 1 ? 1 : -1;
    [[0, 0], [dx, 0], [0, dy], [2 * dx, 0], [0, 2 * dy]].forEach(function(o) {
      var c = idx(sx + o[0], sy + o[1]);
      if (grid[c] === SOFT) grid[c] = EMPTY;
    });
  }
  bombs = [];
  // Sudden death spiral: outside -> in
  sdOrder = [];
  var l = 1, t = 1, r = W - 2, b = H - 2;
  while (l <= r && t <= b) {
    for (var xx = l; xx <= r; xx++) sdOrder.push([xx, t]);
    for (var yy = t + 1; yy <= b; yy++) sdOrder.push([r, yy]);
    if (t < b) for (xx = r - 1; xx >= l; xx--) sdOrder.push([xx, b]);
    if (l < r) for (yy = b - 1; yy > t; yy--) sdOrder.push([l, yy]);
    l++; t++; r--; b--;
  }
  sdOrder = sdOrder.filter(function(c) { return grid[idx(c[0], c[1])] !== HARD; });
  sdIndex = 0; suddenDeath = false;
}

// ── Players ──
function newPlayer(id, name, isBot) {
  return {
    id: id, name: name, isBot: isBot, slot: null, color: '#fff',
    x: 0, y: 0, alive: false, dir: null, face: 'd', moving: false,
    maxBombs: START_BOMBS, activeBombs: 0, range: START_RANGE, speed: BASE_SPEED,
    shield: false, kick: false, invulnUntil: 0, wins: 0, bombQueued: false,
    ai: { next: 0, path: [], mode: 'idle' },
  };
}

function resetForRound(p) {
  var sp = SPAWNS[p.slot];
  p.x = sp[0] + 0.5; p.y = sp[1] + 0.5;
  p.alive = true; p.dir = null; p.face = 'd'; p.moving = false;
  p.maxBombs = START_BOMBS; p.activeBombs = 0; p.range = START_RANGE; p.speed = BASE_SPEED;
  p.shield = false; p.kick = false; p.invulnUntil = 0; p.bombQueued = false;
  p.ai = { next: 0, path: [], mode: 'idle' };
}

function humansInSlots() {
  var c = 0;
  for (var s = 0; s < SLOTS; s++) { var p = players[slots[s]]; if (p && !p.isBot) c++; }
  return c;
}
function humanCount() {
  var c = 0; for (var id in players) if (!players[id].isBot) c++; return c;
}

function makeBot(slot) {
  var id = 'bot_' + (++botCounter);
  var used = {};
  for (var s = 0; s < SLOTS; s++) if (players[slots[s]]) used[players[slots[s]].name] = true;
  var names = BOT_NAMES.filter(function(n) { return !used[n]; });
  var b = newPlayer(id, names[Math.floor(Math.random() * names.length)] || 'Bot', true);
  b.slot = slot; b.color = COLORS[slot];
  players[id] = b; slots[slot] = id;
  return b;
}

// Give free/bot slots to waiting humans, fill the rest with bots
function seatPlayers() {
  var waiting = Object.keys(players).filter(function(id) { return !players[id].isBot && players[id].slot === null; });
  for (var i = 0; i < waiting.length; i++) {
    var s = slots.indexOf(null);
    if (s === -1) {
      // replace a bot
      for (var k = 0; k < SLOTS; k++) { if (players[slots[k]] && players[slots[k]].isBot) { s = k; break; } }
      if (s === -1) break;
      delete players[slots[s]];
    }
    var p = players[waiting[i]];
    p.slot = s; p.color = COLORS[s]; p.wins = 0; slots[s] = p.id;
  }
  for (var j = 0; j < SLOTS; j++) if (!slots[j] || !players[slots[j]]) makeBot(j);
}

function resetToLobby() {
  for (var id in players) { if (players[id].isBot) delete players[id]; else { players[id].slot = null; players[id].wins = 0; players[id].alive = false; } }
  slots = [null, null, null, null];
  round = 0; bombs = []; lastResult = null;
  setPhase('lobby');
  lobbyStart = humanCount() > 0 ? now() : 0;
}

function setPhase(ph, extra) {
  phase = ph; phaseStart = now();
  var msg = { phase: ph };
  if (extra) for (var k in extra) msg[k] = extra[k];
  io.emit('phase', msg);
}

function startRound() {
  seatPlayers();
  if (humansInSlots() === 0) { resetToLobby(); return; }
  round++;
  buildMap();
  for (var s = 0; s < SLOTS; s++) resetForRound(players[slots[s]]);
  lastResult = null; lastHumanKiller = null;
  setPhase('countdown', { round: round });
}

function endRound(winner) {
  bombs = [];
  for (var i = 0; i < bombGrid.length; i++) bombGrid[i] = null;
  if (winner) winner.wins++;
  lastResult = winner ? { name: winner.name, color: winner.color, wins: winner.wins } : null;
  if (winner && winner.wins >= WINS_TO_MATCH) setPhase('matchEnd', { winner: lastResult });
  else setPhase('roundEnd', { winner: lastResult });
}

// ── Grid queries ──
function solid(x, y) { return !inside(x, y) || grid[idx(x, y)] !== EMPTY; }

function blockedFor(p, x, y) {
  if (solid(x, y)) return true;
  var b = bombGrid[idx(x, y)];
  return !!(b && !b.pass[p.id]);
}

function cellOf(p) { return [Math.floor(p.x), Math.floor(p.y)]; }

var DIRS = { u: [0, -1], d: [0, 1], l: [-1, 0], r: [1, 0] };

// Grid movement with lane snapping + corner assist
function movePlayer(p, dir, dist) {
  var v = DIRS[dir]; if (!v) return false;
  var dx = v[0], dy = v[1], horiz = dx !== 0;
  var cx = Math.floor(p.x), cy = Math.floor(p.y);
  var ax = cx + dx, ay = cy + dy;
  var perp = horiz ? p.y - (cy + 0.5) : p.x - (cx + 0.5);
  var sx = p.x, sy = p.y;
  var aheadBlocked = blockedFor(p, ax, ay);

  if (Math.abs(perp) > 0.001) {
    if (!aheadBlocked) {
      var slide = Math.min(dist, Math.abs(perp));
      if (horiz) p.y -= Math.sign(perp) * slide; else p.x -= Math.sign(perp) * slide;
      dist -= slide;
      if (dist <= 0.0001) return p.x !== sx || p.y !== sy;
    } else {
      // Corner assist: slip into the neighbour lane if it is open ahead
      var n = perp > 0 ? 1 : -1;
      var nx = horiz ? cx : cx + n, ny = horiz ? cy + n : cy;
      if (Math.abs(perp) > 0.18 && !blockedFor(p, nx, ny) && !blockedFor(p, nx + dx, ny + dy)) {
        var toCenter = 1 - Math.abs(perp);
        var sl = Math.min(dist, toCenter);
        if (horiz) p.y += n * sl; else p.x += n * sl;
        return true;
      }
    }
  }

  // Forward movement
  var pos = horiz ? p.x : p.y;
  var center = (horiz ? cx : cy) + 0.5;
  var sgn = horiz ? dx : dy;
  var np = pos + sgn * dist;
  if (aheadBlocked) {
    if (sgn > 0) np = Math.min(np, Math.max(pos, center));
    else np = Math.max(np, Math.min(pos, center));
  }
  if (horiz) p.x = np; else p.y = np;
  return p.x !== sx || p.y !== sy;
}

// ── Bombs ──
function placeBomb(p) {
  if (!p.alive || p.activeBombs >= p.maxBombs) return false;
  var c = cellOf(p), i = idx(c[0], c[1]);
  if (bombGrid[i] || grid[i] !== EMPTY) return false;
  var b = { x: c[0], y: c[1], fx: c[0] + 0.5, fy: c[1] + 0.5, owner: p.id, color: p.color, range: p.range,
            explodeAt: now() + FUSE * 1000, pass: {}, slide: null, done: false };
  // Anyone standing on the cell can walk off it
  for (var id in players) {
    var q = players[id];
    if (q.alive && q.slot !== null) { var qc = cellOf(q); if (qc[0] === c[0] && qc[1] === c[1]) b.pass[id] = true; }
  }
  bombs.push(b); bombGrid[i] = b; p.activeBombs++;
  io.emit('sfx', { t: 'place' });
  return true;
}

function blastCells(bx, by, range) {
  var cells = [[bx, by]];
  for (var d in DIRS) {
    var v = DIRS[d];
    for (var r = 1; r <= range; r++) {
      var x = bx + v[0] * r, y = by + v[1] * r;
      if (!inside(x, y)) break;
      var t = grid[idx(x, y)];
      if (t === HARD) break;
      cells.push([x, y]);
      if (t === SOFT) break;
    }
  }
  return cells;
}

function rollItem() {
  if (Math.random() > ITEM_CHANCE) return null;
  var total = 0; for (var i = 0; i < ITEM_WEIGHTS.length; i++) total += ITEM_WEIGHTS[i];
  var r = Math.random() * total;
  for (var j = 0; j < ITEM_TYPES.length; j++) { r -= ITEM_WEIGHTS[j]; if (r <= 0) return ITEM_TYPES[j]; }
  return ITEM_TYPES[0];
}

function removeBomb(b) {
  b.done = true;
  var i = idx(b.x, b.y);
  if (bombGrid[i] === b) bombGrid[i] = null;
  var k = bombs.indexOf(b); if (k !== -1) bombs.splice(k, 1);
  var o = players[b.owner]; if (o) o.activeBombs = Math.max(0, o.activeBombs - 1);
}

function explode(first) {
  var queue = [first], cells = {}, owners = {}, softs = {}, t = now();
  while (queue.length) {
    var b = queue.shift();
    if (b.done) continue;
    removeBomb(b);
    var cs = blastCells(b.x, b.y, b.range);
    for (var i = 0; i < cs.length; i++) {
      var ci = idx(cs[i][0], cs[i][1]);
      cells[ci] = cs[i];
      if (!owners[ci]) owners[ci] = b.owner;
      if (grid[ci] === SOFT) softs[ci] = true;
      var other = bombGrid[ci];
      if (other && !other.done) queue.push(other);
    }
  }
  var out = [];
  for (var k in cells) {
    var c = +k;
    flameUntil[c] = t + FLAME_MS;
    flameOwner[c] = owners[c];
    if (!softs[c]) itemGrid[c] = null;   // flames burn items lying around
    out.push(cells[k]);
  }
  var broken = [];
  for (var s in softs) {
    var si = +s;
    grid[si] = EMPTY;
    itemGrid[si] = rollItem();
    broken.push([si % W, Math.floor(si / W)]);
  }
  io.emit('boom', { c: out, b: broken });
}

function updateBombs(dt) {
  var t = now();
  // Kicked bombs slide until they hit something
  for (var i = 0; i < bombs.length; i++) {
    var b = bombs[i];
    if (!b.slide) continue;
    var v = DIRS[b.slide];
    var step = KICK_SPEED * dt;
    var nfx = b.fx + v[0] * step, nfy = b.fy + v[1] * step;
    var ncx = Math.floor(nfx + v[0] * 0.49), ncy = Math.floor(nfy + v[1] * 0.49);
    var blocked = solid(ncx, ncy) || (bombGrid[idx(ncx, ncy)] && bombGrid[idx(ncx, ncy)] !== b) || itemGrid[idx(ncx, ncy)];
    if (!blocked) {
      for (var id in players) {
        var q = players[id];
        if (q.alive && q.slot !== null && Math.floor(q.x) === ncx && Math.floor(q.y) === ncy && !(ncx === b.x && ncy === b.y)) { blocked = true; break; }
      }
    }
    if (blocked) {
      b.slide = null; b.fx = b.x + 0.5; b.fy = b.y + 0.5;
    } else {
      b.fx = nfx; b.fy = nfy;
      var cx = Math.floor(b.fx), cy = Math.floor(b.fy);
      if (cx !== b.x || cy !== b.y) {
        if (bombGrid[idx(b.x, b.y)] === b) bombGrid[idx(b.x, b.y)] = null;
        b.x = cx; b.y = cy; bombGrid[idx(cx, cy)] = b; b.pass = {};
      }
    }
  }
  // Clear "pass" once the owner walks off
  for (var j = 0; j < bombs.length; j++) {
    var bb = bombs[j];
    for (var pid in bb.pass) {
      var p = players[pid];
      if (!p || !p.alive || Math.floor(p.x) !== bb.x || Math.floor(p.y) !== bb.y) delete bb.pass[pid];
    }
  }
  // Fuse / flames
  for (var k = bombs.length - 1; k >= 0; k--) {
    var bo = bombs[k];
    if (!bo || bo.done) continue;
    if (t >= bo.explodeAt || flameUntil[idx(bo.x, bo.y)] > t) { explode(bo); k = bombs.length; }
  }
}

function tryKick(p, dir) {
  if (!p.kick) return;
  var v = DIRS[dir], c = cellOf(p);
  var b = bombGrid[idx(c[0] + v[0], c[1] + v[1])];
  if (!b || b.slide || b.pass[p.id]) return;
  // Only when pressing against it
  var off = dir === 'r' ? (c[0] + 0.5) - p.x : dir === 'l' ? p.x - (c[0] + 0.5) : dir === 'd' ? (c[1] + 0.5) - p.y : p.y - (c[1] + 0.5);
  if (Math.abs(off) < 0.05) { b.slide = dir; io.emit('sfx', { t: 'kick' }); }
}

function hitPlayer(p, t, killerId) {
  if (t < p.invulnUntil) return;
  if (p.shield) { p.shield = false; p.invulnUntil = t + INVULN_MS; io.emit('sfx', { t: 'shield' }); return; }
  killPlayer(p, killerId);
}

// killerId: bomb owner id, 'wall' for sudden death
function killPlayer(p, killerId) {
  if (!p.alive) return;
  p.alive = false;
  var k = players[killerId];
  if (!p.isBot) lastHumanKiller = k && k !== p ? k : null;
  var text = killerId === 'wall' ? p.name + ' fue aplastado'
    : !k ? p.name + ' explotó'
    : k === p ? p.name + ' se autoexplotó'
    : k.name + ' explotó a ' + p.name;
  io.emit('death', { x: p.x, y: p.y, color: p.color, name: p.name, text: text, self: k === p });
}

function pickItem(p) {
  var c = cellOf(p), i = idx(c[0], c[1]);
  var it = itemGrid[i]; if (!it) return;
  itemGrid[i] = null;
  if (it === 'bomb') p.maxBombs = Math.min(MAX_BOMBS, p.maxBombs + 1);
  else if (it === 'fire') p.range = Math.min(MAX_RANGE, p.range + 1);
  else if (it === 'speed') p.speed = Math.min(MAX_SPEED, p.speed + SPEED_STEP);
  else if (it === 'shield') p.shield = true;
  else if (it === 'kick') p.kick = true;
  if (!p.isBot) io.to(p.id).emit('sfx', { t: 'item', it: it });
}

function updateSuddenDeath(t) {
  var elapsed = (t - phaseStart) / 1000;
  if (!suddenDeath && elapsed >= ROUND_TIME) { suddenDeath = true; sdNext = t; io.emit('msg', { text: '¡MUERTE SÚBITA!', color: '#EF4444' }); }
  if (!suddenDeath) return;
  while (sdIndex < sdOrder.length && t >= sdNext) {
    var c = sdOrder[sdIndex++], i = idx(c[0], c[1]);
    grid[i] = HARD; itemGrid[i] = null; flameUntil[i] = 0;
    if (bombGrid[i]) removeBomb(bombGrid[i]);
    for (var id in players) {
      var p = players[id];
      if (p.alive && p.slot !== null && Math.floor(p.x) === c[0] && Math.floor(p.y) === c[1]) killPlayer(p, 'wall');
    }
    io.emit('wall', { x: c[0], y: c[1] });
    sdNext += SD_STEP * 1000;
  }
}

// ── Bot AI ──
// Danger map: t = seconds until a blast hits the cell (Infinity = safe),
// fl = seconds left on flames already burning, wall = seconds until a sudden-death wall drops
function dangerMap(extra) {
  var t = now();
  var list = bombs.map(function(b) { return { x: b.x, y: b.y, r: b.range, t: b.slide ? 0.4 : (b.explodeAt - t) / 1000 }; });
  if (extra) list.push(extra);
  var blasts = list.map(function(b) { return blastCells(b.x, b.y, b.r); });
  // Chain reactions: a bomb inside another blast goes off with it
  var changed = true, guard = 0;
  while (changed && guard++ < 12) {
    changed = false;
    for (var i = 0; i < list.length; i++) for (var c = 0; c < blasts[i].length; c++) {
      for (var j = 0; j < list.length; j++) {
        if (j !== i && list[j].x === blasts[i][c][0] && list[j].y === blasts[i][c][1] && list[j].t > list[i].t) { list[j].t = list[i].t; changed = true; }
      }
    }
  }
  var D = { t: new Array(W * H), fl: new Array(W * H), wall: new Array(W * H) };
  for (var k = 0; k < W * H; k++) { D.t[k] = Infinity; D.wall[k] = Infinity; D.fl[k] = flameUntil[k] > t ? (flameUntil[k] - t) / 1000 : 0; }
  for (var b = 0; b < list.length; b++) for (var m = 0; m < blasts[b].length; m++) {
    var ci = idx(blasts[b][m][0], blasts[b][m][1]);
    D.t[ci] = Math.min(D.t[ci], list[b].t);
  }
  var untilSd = suddenDeath ? (sdNext - t) / 1000 : ROUND_TIME - (t - phaseStart) / 1000;
  if (untilSd < 5) {
    for (var s = sdIndex; s < Math.min(sdOrder.length, sdIndex + 14); s++) {
      D.wall[idx(sdOrder[s][0], sdOrder[s][1])] = Math.max(0, untilSd) + (s - sdIndex) * SD_STEP;
    }
  }
  return D;
}

function isSafe(D, i) { return D.t[i] === Infinity && D.wall[i] === Infinity; }

// Would we be caught standing in cell i between `arrive` and `arrive + stay`?
function deadlyAt(D, i, arrive, stay) {
  if (D.fl[i] > 0 && D.fl[i] > arrive - 0.05) return true;
  if (D.wall[i] < arrive + stay + 0.3) return true;
  var e = D.t[i];
  if (e === Infinity) return false;
  return arrive + stay > e - 0.15 && arrive < e + FLAME_MS / 1000 + 0.15;
}

// BFS over walkable cells, tracking when we'd enter each one (accounts for being off-centre).
// mode 'safe' avoids any danger, 'flee' only avoids cells that are deadly while we pass through
function bfs(p, D, mode) {
  var start = cellOf(p), si = idx(start[0], start[1]);
  var dist = new Array(W * H), prev = new Array(W * H), enter = new Array(W * H), order = [];
  for (var i = 0; i < dist.length; i++) dist[i] = -1;
  dist[si] = 0; prev[si] = -1; enter[si] = 0;
  var step = 1 / p.speed;
  var offX = p.x - (start[0] + 0.5), offY = p.y - (start[1] + 0.5);
  var q = [si];
  while (q.length) {
    var cur = q.shift(); order.push(cur);
    var cx = cur % W, cy = Math.floor(cur / W);
    for (var d in DIRS) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var nx = cx + dx, ny = cy + dy;
      if (!inside(nx, ny)) continue;
      var ni = idx(nx, ny);
      if (dist[ni] !== -1 || solid(nx, ny) || bombGrid[ni]) continue;
      var t;
      if (cur === si) {
        var along = dx ? offX * dx : offY * dy, perp = dx ? Math.abs(offY) : Math.abs(offX);
        t = Math.max(0, 0.5 - along + perp) * step;
      } else t = enter[cur] + step;
      if (mode === 'safe' && (!isSafe(D, ni) || (D.fl[ni] > 0 && D.fl[ni] > t - 0.05))) continue;
      if (mode === 'flee' && deadlyAt(D, ni, t, step + 0.1)) continue;
      dist[ni] = dist[cur] + 1; prev[ni] = cur; enter[ni] = t; q.push(ni);
    }
  }
  return { dist: dist, prev: prev, enter: enter, order: order, start: si };
}

function pathTo(res, target) {
  var path = [], c = target;
  while (c !== -1 && c !== res.start && c !== undefined) { path.unshift([c % W, Math.floor(c / W)]); c = res.prev[c]; }
  return path;
}

function enemyCells(p) {
  var set = {};
  for (var id in players) {
    var q = players[id];
    if (q !== p && q.alive && q.slot !== null) set[idx(Math.floor(q.x), Math.floor(q.y))] = true;
  }
  return set;
}

function bombValue(p, x, y, enemies) {
  var cs = blastCells(x, y, p.range), soft = 0, enemy = 0;
  for (var i = 0; i < cs.length; i++) {
    var ci = idx(cs[i][0], cs[i][1]);
    if (grid[ci] === SOFT) soft++;
    if (enemies[ci]) enemy++;
  }
  return { soft: soft, enemy: enemy };
}

function canEscapeAfterBomb(p, x, y) {
  var D = dangerMap({ x: x, y: y, r: p.range, t: FUSE });
  var res = bfs(p, D, 'flee');
  for (var i = 0; i < res.order.length; i++) {
    var c = res.order[i];
    if (res.dist[c] > 0 && res.dist[c] <= 6 && isSafe(D, c)) return true;
  }
  return false;
}

function botThink(p, t) {
  var D = dangerMap();
  var c = cellOf(p), ci = idx(c[0], c[1]);

  // 1. Danger: run to the closest safe cell
  if (!isSafe(D, ci)) {
    var res = bfs(p, D, 'flee');
    for (var i = 0; i < res.order.length; i++) {
      if (isSafe(D, res.order[i])) { p.ai.path = pathTo(res, res.order[i]); p.ai.mode = 'flee'; return; }
    }
    // No way out yet: buy time in the cell that blows last (flames may clear meanwhile)
    var best = res.start, bestT = -Infinity;
    for (var j = 0; j < res.order.length; j++) {
      var o = res.order[j], left = Math.min(D.t[o], D.wall[o]) - res.enter[o];
      if (left > bestT + 0.05) { bestT = left; best = o; }
    }
    p.ai.path = best === res.start ? [] : pathTo(res, best);
    p.ai.mode = 'panic';
    return;
  }

  var enemies = enemyCells(p);

  // 2. Bomb here if worthwhile and we can get away
  if (p.activeBombs < p.maxBombs && !bombGrid[ci]) {
    var v = bombValue(p, c[0], c[1], enemies);
    var want = (v.enemy > 0 && Math.random() < 0.55) || (v.soft > 0 && p.ai.mode === 'goal' && p.ai.path.length === 0);
    if (want && canEscapeAfterBomb(p, c[0], c[1])) {
      p.bombQueued = true; p.ai.path = []; p.ai.mode = 'idle'; p.ai.next = t + 60;
      return;
    }
  }

  // 3. Pick a goal: items > good bomb spots > hunting
  var safe = bfs(p, D, 'safe');
  var bestCell = -1, bestScore = Infinity;
  for (var k = 0; k < safe.order.length; k++) {
    var cell = safe.order[k], d = safe.dist[cell];
    if (d > 14) break;
    var x = cell % W, y = Math.floor(cell / W), score = Infinity;
    if (itemGrid[cell]) score = d - 4;
    else if (p.activeBombs < p.maxBombs) {
      var bv = bombValue(p, x, y, enemies);
      if (bv.enemy) score = d - 3;
      else if (bv.soft) score = d - bv.soft * 0.6;
    }
    if (score < bestScore) { bestScore = score; bestCell = cell; }
  }
  if (bestCell !== -1 && bestCell !== safe.start) { p.ai.path = pathTo(safe, bestCell); p.ai.mode = 'goal'; return; }
  // Standing on the best spot but step 2 didn't bomb: arm it for the next think, then give up and wander
  if (bestCell === safe.start && p.ai.mode !== 'goal') { p.ai.path = []; p.ai.mode = 'goal'; return; }

  // 4. Nothing to do: walk towards the nearest enemy, or wander
  var target = -1;
  for (var m = 0; m < safe.order.length; m++) {
    var ec = safe.order[m], ex = ec % W, ey = Math.floor(ec / W);
    for (var dd in DIRS) { if (enemies[idx(ex + DIRS[dd][0], ey + DIRS[dd][1])]) { target = ec; break; } }
    if (target !== -1) break;
  }
  if (target === -1 && safe.order.length > 1) target = safe.order[1 + Math.floor(Math.random() * (safe.order.length - 1))];
  p.ai.path = target !== -1 ? pathTo(safe, target).slice(0, 4) : [];
  p.ai.mode = 'wander';
}

function botStep(p, t) {
  if (t >= p.ai.next) { botThink(p, t); p.ai.next = t + (p.ai.mode === 'flee' || p.ai.mode === 'panic' ? 80 : BOT_THINK_MS + Math.random() * 120); }
  p.dir = null;
  while (p.ai.path.length) {
    var n = p.ai.path[0];
    var tx = n[0] + 0.5, ty = n[1] + 0.5;
    if (Math.abs(p.x - tx) < 0.08 && Math.abs(p.y - ty) < 0.08) { p.x = tx; p.y = ty; p.ai.path.shift(); continue; }
    var c = cellOf(p);
    if (n[0] !== c[0] || n[1] !== c[1]) {
      // Stale path (not adjacent) -> rethink next tick
      if (Math.abs(n[0] - c[0]) + Math.abs(n[1] - c[1]) > 1) { p.ai.path = []; p.ai.next = 0; break; }
      p.dir = n[0] > c[0] ? 'r' : n[0] < c[0] ? 'l' : n[1] > c[1] ? 'd' : 'u';
    } else {
      p.dir = tx > p.x ? 'r' : tx < p.x ? 'l' : ty > p.y ? 'd' : 'u';
    }
    // Never step into flames: wait for them to clear
    if ((n[0] !== c[0] || n[1] !== c[1]) && flameUntil[idx(n[0], n[1])] > t) { p.dir = null; break; }
    // Next cell became blocked (new bomb, etc.)
    var dv = DIRS[p.dir];
    if (n[0] !== c[0] || n[1] !== c[1]) { if (blockedFor(p, c[0] + dv[0], c[1] + dv[1])) { p.ai.path = []; p.ai.next = 0; p.dir = null; } }
    break;
  }
}

// ── Main loop ──
var lastTick = now();
setInterval(function() {
  var t = now(), dt = Math.min(0.05, (t - lastTick) / 1000); lastTick = t;
  var el = (t - phaseStart) / 1000;

  if (phase === 'lobby') {
    if (humanCount() > 0) {
      if (!lobbyStart) lobbyStart = t;
      if ((t - lobbyStart) / 1000 >= LOBBY_TIME) startRound();
    } else lobbyStart = 0;
    return;
  }
  if (phase === 'countdown') { if (el >= COUNTDOWN) setPhase('playing'); return; }
  if (phase === 'roundEnd') { if (el >= ROUND_END_TIME) startRound(); return; }
  if (phase === 'matchEnd') { if (el >= MATCH_END_TIME) resetToLobby(); return; }
  if (phase !== 'playing') return;

  var inPlay = slots.map(function(id) { return players[id]; }).filter(function(p) { return p; });

  for (var i = 0; i < inPlay.length; i++) {
    var p = inPlay[i];
    if (!p.alive) continue;
    if (p.isBot) botStep(p, t);
    if (p.bombQueued) { p.bombQueued = false; placeBomb(p); }
    if (p.dir) {
      p.face = p.dir;
      p.moving = movePlayer(p, p.dir, p.speed * dt);
      if (!p.moving) tryKick(p, p.dir);
    } else p.moving = false;
    pickItem(p);
  }

  updateBombs(dt);
  updateSuddenDeath(t);

  for (var j = 0; j < inPlay.length; j++) {
    var q = inPlay[j];
    var qi = idx(Math.floor(q.x), Math.floor(q.y));
    if (q.alive && flameUntil[qi] > t) hitPlayer(q, t, flameOwner[qi]);
  }

  var alive = inPlay.filter(function(p) { return p.alive; });
  var aliveHumans = alive.filter(function(p) { return !p.isBot; });
  if (alive.length <= 1) endRound(alive[0] || null);
  else if (aliveHumans.length === 0 && humansInSlots() > 0) endRound(lastHumanKiller && lastHumanKiller.alive ? lastHumanKiller : null);
}, 1000 / TPS);

// ── Network ──
function r2(v) { return Math.round(v * 100) / 100; }
setInterval(function() {
  var t = now();
  var el = (t - phaseStart) / 1000;
  var base = { ph: phase, rd: round, sd: suddenDeath ? 1 : 0, wt: WINS_TO_MATCH };
  if (phase === 'lobby') {
    base.lobby = Object.keys(players).filter(function(id) { return !players[id].isBot; }).map(function(id) { return players[id].name; });
    base.tl = lobbyStart ? Math.max(0, Math.ceil(LOBBY_TIME - (t - lobbyStart) / 1000)) : LOBBY_TIME;
  } else {
    base.tl = phase === 'playing' ? Math.max(0, Math.ceil(ROUND_TIME - el)) : phase === 'countdown' ? Math.ceil(COUNTDOWN - el) : 0;
    var g = ''; for (var i = 0; i < grid.length; i++) g += grid[i];
    base.g = g;
    base.p = [];
    for (var s = 0; s < SLOTS; s++) {
      var p = players[slots[s]]; if (!p) continue;
      base.p.push({ s: s, n: p.name, c: p.color, x: r2(p.x), y: r2(p.y), a: p.alive ? 1 : 0, f: p.face, m: p.moving ? 1 : 0,
        w: p.wins, b: p.isBot ? 1 : 0, sh: p.shield ? 1 : 0, iv: t < p.invulnUntil ? 1 : 0,
        st: [p.maxBombs, p.range, Math.round((p.speed - BASE_SPEED) / SPEED_STEP) + 1, p.kick ? 1 : 0] });
    }
    base.bo = bombs.map(function(b) { return [r2(b.fx), r2(b.fy), r2(Math.max(0, (b.explodeAt - t) / (FUSE * 1000))), b.color]; });
    base.fl = []; base.it = [];
    for (var k = 0; k < flameUntil.length; k++) {
      if (flameUntil[k] > t) base.fl.push([k % W, Math.floor(k / W), r2((flameUntil[k] - t) / FLAME_MS)]);
      if (itemGrid[k]) base.it.push([k % W, Math.floor(k / W), ITEM_TYPES.indexOf(itemGrid[k])]);
    }
  }
  for (var id in players) {
    if (players[id].isBot) continue;
    base.me = players[id].slot;
    io.volatile.to(id).emit('s', base);
  }
}, 1000 / NET_TPS);

// ── Sockets ──
io.on('connection', function(socket) {
  socket.emit('cfg', { w: W, h: H, items: ITEM_TYPES });

  socket.on('join', function(data) {
    if (players[socket.id]) return;
    var p = newPlayer(socket.id, cleanName(data && data.name), false);
    players[socket.id] = p;
    if (phase === 'lobby') {
      if (!lobbyStart) lobbyStart = now();
    } else if (phase === 'countdown' || phase === 'playing') {
      // Take over a bot (keeps its position), otherwise spectate until next round
      for (var s = 0; s < SLOTS; s++) {
        var b = players[slots[s]];
        if (b && b.isBot && (b.alive || phase === 'countdown')) {
          p.slot = s; p.color = b.color; p.x = b.x; p.y = b.y; p.alive = b.alive;
          p.maxBombs = b.maxBombs; p.range = b.range; p.speed = b.speed; p.shield = b.shield; p.kick = b.kick;
          p.activeBombs = b.activeBombs;
          bombs.forEach(function(bo) { if (bo.owner === b.id) bo.owner = p.id; if (bo.pass[b.id]) bo.pass[p.id] = true; });
          delete players[b.id]; slots[s] = p.id;
          io.emit('msg', { text: p.name + ' reemplazó a ' + b.name, color: p.color });
          break;
        }
      }
    }
    socket.emit('phase', { phase: phase, winner: lastResult });
  });

  socket.on('start', function() {
    if (phase === 'lobby' && players[socket.id]) startRound();
  });

  socket.on('input', function(d) {
    var p = players[socket.id];
    if (!p || !d) return;
    p.dir = DIRS[d.d] ? d.d : null;
  });

  socket.on('bomb', function() {
    var p = players[socket.id];
    if (p && p.alive && phase === 'playing') p.bombQueued = true;
  });

  socket.on('disconnect', function() {
    var p = players[socket.id];
    if (!p) return;
    delete players[socket.id];
    if (p.slot !== null && phase !== 'lobby') {
      // Leave a bot in their place so the round keeps going
      var b = newPlayer('bot_' + (++botCounter), 'Bot ' + p.name.substring(0, 8), true);
      ['slot', 'color', 'x', 'y', 'alive', 'maxBombs', 'activeBombs', 'range', 'speed', 'shield', 'kick', 'wins', 'face'].forEach(function(k) { b[k] = p[k]; });
      bombs.forEach(function(bo) { if (bo.owner === p.id) bo.owner = b.id; if (bo.pass[p.id]) bo.pass[b.id] = true; });
      players[b.id] = b; slots[p.slot] = b.id;
    }
    if (humanCount() === 0 && phase !== 'lobby') resetToLobby();
  });
});

};
