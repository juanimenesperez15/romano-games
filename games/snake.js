module.exports = function(io) {

// ── Config ──
var WORLD_W = 2600, WORLD_H = 2600, GAME_TPS = 60, NET_TPS = 30;
var FOOD_COUNT = 650, MAX_FOOD = 1600, POWERUP_COUNT = 10;
var SPEED = 3.2, BOOST_SPEED = 5.8;
var SEGMENT_DIST = 12, START_LENGTH = 15, SEG_DIST_SQ = SEGMENT_DIST * SEGMENT_DIST;
var SPAWN_PROTECT = 2500;          // ms of pass-through after (re)spawning
var MIN_SNAKES = 9;                // bots fill up to this many snakes while someone is playing
var BOT_RESPAWN = 2500;
var VIEW_DEFAULT = 1200, VIEW_MAX = 1800;   // half-size of the area sent to each client (clients report theirs)
var LB_EVERY = 15;                 // send leaderboard every N network ticks
var STREAKS = [3, 5, 8, 12, 20];
var HASH = 80;                     // spatial hash cell size

var players = {}, food = [], powerups = [], allTimeScores = [];
var botCounter = 0, tick = 0, botRespawnAt = 0, nidCounter = 0, foodCounter = 0, pwCounter = 0;
// Changes since the last network tick: clients keep their own copy of food/power-ups
var foodAdd = [], foodDel = [], foodMoved = {}, pwDirty = true;
var FOOD_COLORS = 12;              // client palette indexes; FOOD_COLORS itself = grey boost droppings

var POWERUP_TYPES = [
  { type: 'speed',  color: '#FBBF24', icon: '⚡',             duration: 5000 },
  { type: 'shield', color: '#3B82F6', icon: '🛡️', duration: 5000 },
  { type: 'magnet', color: '#A78BFA', icon: '🧲',       duration: 7000 },
  { type: 'x2',     color: '#22C55E', icon: '✖️2',      duration: 8000 },
  { type: 'shrink', color: '#EF4444', icon: '💀',       duration: 0 },
  { type: 'ghost',  color: '#94A3B8', icon: '👻',       duration: 4000 },
];

var BOT_NAMES = ['Fideo', 'Chorizo', 'Tallarin', 'Manguera', 'Morcilla', 'Lombri', 'Vibora', 'Anaconda', 'Cordon',
  'Salchicha', 'Spaghetti', 'Serpentina', 'Gusanito', 'Culebra', 'Pitón', 'Moncho', 'Tito', 'Cacho'];
var BOT_SKINS = ['#F97316,#FBBF24', '#EC4899,#A78BFA', '#22C55E,#A3E635', '#EF4444,#111827', '#38BDF8,#F0F9FF',
  '#FACC15,#1F2937,#FACC15', '#8B5CF6,#EC4899,#F59E0B', '#14B8A6,#0EA5E9', '#F43F5E,#FDA4AF', '#84CC16,#15803D'];

function rnd(a, b) { return a + Math.random() * (b - a); }
function cleanName(n, def) { return String(n || def).replace(/[<>&"'`]/g, '').trim().substring(0, 15) || def; }
function cleanSkin(s) {
  if (typeof s !== 'string') return 'classic';
  var ok = s.split(',').filter(function(c) { return /^#[0-9a-fA-F]{3,8}$/.test(c); }).slice(0, 6);
  return ok.length ? ok.join(',') : 'classic';
}
function makeFood(x, y, r, v, c) { return { id: ++foodCounter, x: x, y: y, r: r, v: v, c: c }; }
function spawnFood() { return makeFood(rnd(20, WORLD_W - 20), rnd(20, WORLD_H - 20), rnd(4, 7), 1, Math.floor(Math.random() * FOOD_COLORS)); }
function addFood(f) { food.push(f); foodAdd.push(f); }
// Eaten (or vanished) food at index i; refills up to FOOD_COUNT
function removeFood(i, eater) {
  foodDel.push([food[i].id, eater ? eater.nid : 0]);
  delete foodMoved[food[i].id];
  if (food.length > FOOD_COUNT) food.splice(i, 1);
  else { food[i] = spawnFood(); foodAdd.push(food[i]); }
}
function spawnPowerup() {
  var t = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  return { id: ++pwCounter, x: rnd(100, WORLD_W - 100), y: rnd(100, WORLD_H - 100), r: 13, type: t.type, color: t.color, icon: t.icon };
}
for (var i = 0; i < FOOD_COUNT; i++) food.push(spawnFood());
for (var j = 0; j < POWERUP_COUNT; j++) powerups.push(spawnPowerup());

function distSq(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function angleDiff(a, b) { var d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }
function hasEffect(p, type) { return p.effects[type] && p.effects[type] > Date.now(); }
// Body thickness grows with length (client uses the same formula)
function widthOf(len) { return 10 + Math.min(len / 22, 7) * 2.6; }

// ── Spatial hash of every body segment, rebuilt each tick ──
var hash = {};
function hkey(cx, cy) { return cx * 10000 + cy; }
function buildHash() {
  hash = {};
  for (var id in players) {
    var p = players[id];
    if (!p.alive) continue;
    for (var i = 0; i < p.segments.length; i++) {
      var s = p.segments[i], k = hkey(Math.floor(s.x / HASH), Math.floor(s.y / HASH));
      (hash[k] || (hash[k] = [])).push(p, i);
    }
  }
}
// Calls fn(player, segIndex, seg) for segments near (x, y)
function nearby(x, y, radius, fn) {
  var x0 = Math.floor((x - radius) / HASH), x1 = Math.floor((x + radius) / HASH);
  var y0 = Math.floor((y - radius) / HASH), y1 = Math.floor((y + radius) / HASH);
  for (var cx = x0; cx <= x1; cx++) for (var cy = y0; cy <= y1; cy++) {
    var b = hash[hkey(cx, cy)];
    if (!b) continue;
    for (var i = 0; i < b.length; i += 2) {
      var seg = b[i].segments[b[i + 1]];   // may have been trimmed earlier this tick
      if (seg && fn(b[i], b[i + 1], seg) === false) return;
    }
  }
}

// ── Players ──
function findSpawn() {
  var best = null, bestD = -1;
  for (var t = 0; t < 24; t++) {
    var c = { x: rnd(250, WORLD_W - 250), y: rnd(250, WORLD_H - 250) }, d = Infinity;
    for (var id in players) {
      var p = players[id];
      if (!p.alive) continue;
      for (var i = 0; i < p.segments.length; i += 4) d = Math.min(d, distSq(c, p.segments[i]));
    }
    if (d > bestD) { bestD = d; best = c; }
    if (d > 400 * 400) break;
  }
  return best;
}

function createPlayer(id, name, skin, isBot) {
  // Start heading roughly towards the middle so nobody spawns facing a wall
  var sp = findSpawn(), angle = Math.atan2(WORLD_H / 2 - sp.y, WORLD_W / 2 - sp.x) + rnd(-0.6, 0.6), segments = [];
  for (var i = 0; i < START_LENGTH; i++) segments.push({ x: sp.x - Math.cos(angle) * i * SEGMENT_DIST, y: sp.y - Math.sin(angle) * i * SEGMENT_DIST });
  var now = Date.now();
  return {
    id: id, nid: ++nidCounter, name: name, skin: skin, isBot: !!isBot, segments: segments, angle: angle, targetAngle: angle,
    boosting: false, score: 0, alive: true, effects: { spawn: now + SPAWN_PROTECT },
    kills: 0, maxLen: START_LENGTH, bornAt: now, view: { w: VIEW_DEFAULT, h: VIEW_DEFAULT },
    ai: isBot ? { target: null, retarget: 0, aggro: rnd(0.2, 0.9), phase: Math.floor(Math.random() * 4) } : null,
  };
}

function humanCount() { var c = 0; for (var id in players) if (!players[id].isBot) c++; return c; }

function manageBots(now) {
  var humans = humanCount(), bots = [];
  for (var id in players) if (players[id].isBot) bots.push(id);
  if (humans === 0) { bots.forEach(function(b) { delete players[b]; }); return; }
  // Too many snakes: retire bots
  var extra = humans + bots.length - MIN_SNAKES;
  for (var i = 0; i < bots.length && extra > 0; i++, extra--) { dropFood(players[bots[i]]); delete players[bots[i]]; }
  if (humans + bots.length < MIN_SNAKES && now >= botRespawnAt) {
    var used = {}; for (var pid in players) used[players[pid].name] = true;
    var free = BOT_NAMES.filter(function(n) { return !used[n]; });
    var id2 = 'bot_' + (++botCounter);
    players[id2] = createPlayer(id2, free[Math.floor(Math.random() * free.length)] || 'Gusano', BOT_SKINS[Math.floor(Math.random() * BOT_SKINS.length)], true);
    botRespawnAt = now + BOT_RESPAWN / 2;
  }
}

// Scatter food along the whole body, worth roughly what the snake was
function dropFood(p) {
  var segs = p.segments, n = Math.min(Math.ceil(segs.length / 2), 150), value = Math.max(1, Math.round(segs.length / 2 / n));
  for (var i = 0; i < n && food.length < MAX_FOOD; i++) {
    var s = segs[Math.floor(i * segs.length / n)];
    addFood(makeFood(Math.max(5, Math.min(WORLD_W - 5, s.x + rnd(-14, 14))), Math.max(5, Math.min(WORLD_H - 5, s.y + rnd(-14, 14))),
      6 + value * 1.5 + Math.random() * 3, value + 1, Math.floor(Math.random() * FOOD_COLORS)));
  }
}

function applyPowerup(p, type) {
  var def = POWERUP_TYPES.find(function(t) { return t.type === type; });
  if (!def) return;
  if (type === 'shrink') {
    for (var oid in players) {
      if (oid === p.id) continue;
      var o = players[oid];
      if (!o.alive || hasEffect(o, 'shield')) continue;
      var rm = Math.floor(o.segments.length * 0.2);
      for (var i = 0; i < rm && o.segments.length > 5; i++) { o.segments.pop(); o.score = Math.max(0, o.score - 1); }
    }
  } else p.effects[type] = Date.now() + def.duration;
}

function addScore(name, score) {
  allTimeScores.push({ name: name, score: score, time: Date.now() });
  allTimeScores.sort(function(a, b) { return b.score - a.score; });
  if (allTimeScores.length > 50) allTimeScores.length = 50;
}
function getTop() { return allTimeScores.slice(0, 10).map(function(e) { return { n: e.name, s: e.score }; }); }

function killPlayer(p, killer) {
  if (!p.alive) return;
  p.alive = false;
  var len = p.segments.length;
  dropFood(p);
  var h = p.segments[0];
  io.to('game').emit('boom', { x: Math.round(h.x), y: Math.round(h.y), c: (p.skin === 'classic' ? '#4ECDC4' : p.skin.split(',')[0]), l: len });
  if (killer) {
    killer.kills++;
    io.to('game').emit('kill', { k: killer.name, v: p.name, l: len, ki: killer.nid, vi: p.nid });
    if (STREAKS.indexOf(killer.kills) !== -1) io.to('game').emit('streak', { n: killer.name, k: killer.kills, i: killer.nid });
  }
  if (p.isBot) { delete players[p.id]; botRespawnAt = Math.max(botRespawnAt, Date.now() + BOT_RESPAWN); return; }
  addScore(p.name, p.maxLen);
  // Keep watching: the camera follows whoever got you
  p.deadAt = Date.now(); p.deathPos = { x: h.x, y: h.y }; p.watch = killer ? killer.id : null;
  io.to(p.id).emit('dead', {
    killer: killer ? killer.name : null, score: len, max: p.maxLen, kills: p.kills,
    time: Math.round((Date.now() - p.bornAt) / 1000), ranking: getTop(),
  });
}

// ── Bot AI ──
// How far we can go along `ang` before hitting a body or the border
function clearance(b, ang, maxDist) {
  var h = b.segments[0], w = widthOf(b.segments.length), step = 14;
  var cos = Math.cos(ang), sin = Math.sin(ang);
  for (var d = step; d <= maxDist; d += step) {
    var x = h.x + cos * d, y = h.y + sin * d;
    if (x < 20 || y < 20 || x > WORLD_W - 20 || y > WORLD_H - 20) return d;
    var hit = false;
    nearby(x, y, 40, function(o, i, s) {
      if (o === b) return;
      var r = (w + widthOf(o.segments.length)) / 2 + 8;
      if ((s.x - x) * (s.x - x) + (s.y - y) * (s.y - y) < r * r) { hit = true; return false; }
    });
    if (hit) return d;
  }
  return Infinity;
}

function botThink(b, now) {
  var h = b.segments[0], len = b.segments.length, ai = b.ai;
  b.boosting = false;
  // Pick a goal every so often: prey (if feeling brave) or the juiciest food nearby
  if (now >= ai.retarget || !ai.target) {
    ai.target = null; ai.hunt = null;
    if (len > 30 && Math.random() < ai.aggro) {
      var bestP = null, bd = 380 * 380;
      for (var id in players) {
        var o = players[id];
        if (o === b || !o.alive || hasEffect(o, 'spawn')) continue;
        var d = distSq(h, o.segments[0]);
        if (d < bd && o.segments.length < len * 1.3) { bd = d; bestP = o; }
      }
      if (bestP) ai.hunt = bestP.id;
    }
    if (!ai.hunt) {
      var best = null, bs = 0;
      for (var i = 0; i < food.length; i++) {
        var f = food[i], fd = distSq(h, f);
        if (fd > 450 * 450) continue;
        var sc = f.v * f.v / (Math.sqrt(fd) + 40);
        if (sc > bs) { bs = sc; best = f; }
      }
      for (var k = 0; k < powerups.length; k++) {
        var pw = powerups[k], pd = distSq(h, pw);
        if (pd < 350 * 350 && 4 / (Math.sqrt(pd) + 40) > bs) { bs = 4 / (Math.sqrt(pd) + 40); best = pw; }
      }
      ai.target = best || { x: WORLD_W / 2 + rnd(-600, 600), y: WORLD_H / 2 + rnd(-600, 600) };
    }
    ai.retarget = now + rnd(500, 1100);
  }
  var gx, gy;
  var prey = ai.hunt && players[ai.hunt];
  if (prey && prey.alive) {
    // Aim ahead of the prey's head to cut it off
    var ph = prey.segments[0];
    gx = ph.x + Math.cos(prey.angle) * 110; gy = ph.y + Math.sin(prey.angle) * 110;
    if (len > 40 && distSq(h, ph) < 260 * 260) b.boosting = true;
  } else {
    if (ai.hunt) { ai.hunt = null; ai.retarget = 0; }
    gx = ai.target.x; gy = ai.target.y;
    if (food.indexOf(ai.target) === -1 && powerups.indexOf(ai.target) === -1 && distSq(h, ai.target) < 60 * 60) ai.retarget = 0;
  }
  var goal = Math.atan2(gy - h.y, gx - h.x);
  // Walls push the goal inwards well before we get there
  var WM = 260, vx = Math.cos(goal), vy = Math.sin(goal), push = 0;
  if (h.x < WM) { vx += (WM - h.x) / WM * 3; push++; }
  if (h.x > WORLD_W - WM) { vx -= (h.x - WORLD_W + WM) / WM * 3; push++; }
  if (h.y < WM) { vy += (WM - h.y) / WM * 3; push++; }
  if (h.y > WORLD_H - WM) { vy -= (h.y - WORLD_H + WM) / WM * 3; push++; }
  if (push) { goal = Math.atan2(vy, vx); b.boosting = false; }
  // Steer: the direction closest to the goal that is clear, otherwise the clearest one
  var look = 120 + widthOf(len) * 4 + (b.boosting ? 60 : 0);
  var bestA = goal, bestScore = -Infinity;
  for (var c = 0; c < 13; c++) {
    var off = (c === 0 ? 0 : Math.ceil(c / 2) * (c % 2 ? 1 : -1)) * 0.24;
    var a = goal + off, cl = clearance(b, a, look);
    var score = (cl === Infinity ? look + 50 : cl) - Math.abs(angleDiff(b.angle, a)) * 22 - Math.abs(off) * 30;
    if (cl === Infinity && c === 0) { bestA = a; break; }
    if (score > bestScore) { bestScore = score; bestA = a; }
  }
  b.targetAngle = bestA;
}

// ── Physics ──
setInterval(function() {
  var now = Date.now();
  tick++;
  manageBots(now);
  buildHash();

  for (var id in players) {
    var p = players[id];
    if (!p.alive) continue;
    var len = p.segments.length;
    if (p.isBot && (tick + p.ai.phase) % 4 === 0) botThink(p, now);

    // Turning gets a bit slower as you grow
    var maxTurn = Math.max(0.075, 0.16 - len * 0.00025);
    var d = angleDiff(p.angle, p.targetAngle);
    p.angle += Math.max(-maxTurn, Math.min(maxTurn, d * 0.25));
    if (p.angle > Math.PI) p.angle -= Math.PI * 2; else if (p.angle < -Math.PI) p.angle += Math.PI * 2;

    var canBoost = p.boosting && len > 10;
    var speed = canBoost ? BOOST_SPEED : SPEED;
    if (hasEffect(p, 'speed')) speed *= 1.45;
    if (canBoost && Math.random() < 0.15) {
      var tail = p.segments.pop();
      if (food.length < MAX_FOOD) addFood(makeFood(tail.x, tail.y, 4, 1, FOOD_COLORS));
      p.score = Math.max(0, p.score - 2);
    }

    var head = p.segments[0], nh = { x: head.x + Math.cos(p.angle) * speed, y: head.y + Math.sin(p.angle) * speed };
    if (nh.x < 0 || nh.x > WORLD_W || nh.y < 0 || nh.y > WORLD_H) {
      if (hasEffect(p, 'shield') || hasEffect(p, 'spawn')) {
        nh.x = Math.max(5, Math.min(WORLD_W - 5, nh.x)); nh.y = Math.max(5, Math.min(WORLD_H - 5, nh.y));
        p.angle += Math.PI; p.targetAngle = p.angle; delete p.effects.shield;
      } else { killPlayer(p, null); continue; }
    }
    p.segments.unshift(nh);
    for (var si = 1; si < p.segments.length; si++) {
      var pv = p.segments[si - 1], cu = p.segments[si], ds = distSq(pv, cu);
      if (ds > SEG_DIST_SQ) { var dd = Math.sqrt(ds), r = SEGMENT_DIST / dd; cu.x = pv.x + (cu.x - pv.x) * r; cu.y = pv.y + (cu.y - pv.y) * r; }
    }
    while (p.segments.length > START_LENGTH + p.score) p.segments.pop();
    if (p.segments.length > p.maxLen) p.maxLen = p.segments.length;

    var w = widthOf(p.segments.length);
    if (hasEffect(p, 'magnet')) {
      for (var mi = 0; mi < food.length; mi++) {
        var mf = food[mi], md = distSq(nh, mf);
        if (md < 180 * 180 && md > 1) { var mdd = Math.sqrt(md); mf.x += (nh.x - mf.x) / mdd * 3; mf.y += (nh.y - mf.y) / mdd * 3; foodMoved[mf.id] = mf; }
      }
    }
    var multi = hasEffect(p, 'x2') ? 2 : 1, eatR = w / 2 + 10;
    for (var fi = food.length - 1; fi >= 0; fi--) {
      var f = food[fi], th = f.r + eatR;
      if (distSq(nh, f) < th * th) {
        p.score += f.v * multi;
        removeFood(fi, p);
      }
    }
    for (var pi = powerups.length - 1; pi >= 0; pi--) {
      var pw = powerups[pi];
      if (distSq(nh, pw) < (pw.r + eatR) * (pw.r + eatR)) {
        applyPowerup(p, pw.type);
        if (!p.isBot) io.to(id).emit('powerup', { type: pw.type });
        powerups[pi] = spawnPowerup(); pwDirty = true;
      }
    }

    // Head vs other snakes' bodies (no self-collision: coil around your enemies!)
    if (!hasEffect(p, 'ghost') && !hasEffect(p, 'spawn')) {
      var killer = null;
      nearby(nh.x, nh.y, 40, function(o, idx, s) {
        if (o === p || !o.alive || idx < 2) return;
        var cr = (w + widthOf(o.segments.length)) / 2 * 0.8;
        if (distSq(nh, s) < cr * cr) { killer = o; return false; }
      });
      if (killer) {
        if (hasEffect(p, 'shield')) { delete p.effects.shield; p.effects.spawn = now + 600; }
        else killPlayer(p, killer);
      }
    }
  }
  while (powerups.length < POWERUP_COUNT) { powerups.push(spawnPowerup()); pwDirty = true; }
}, 1000 / GAME_TPS);

// ── Network ──
// Bodies go out as binary: head as int16 x,y then int8 deltas between (sub-sampled) points
function encodeBody(segs) {
  var step = Math.max(1, Math.ceil(segs.length / 160)), pts = [];
  for (var i = 0; i < segs.length; i += step) pts.push(segs[i]);
  if (pts[pts.length - 1] !== segs[segs.length - 1]) pts.push(segs[segs.length - 1]);
  var buf = Buffer.alloc(4 + (pts.length - 1) * 2);
  var px = Math.round(pts[0].x), py = Math.round(pts[0].y);
  buf.writeInt16LE(px, 0); buf.writeInt16LE(py, 2);
  for (var k = 1; k < pts.length; k++) {
    var x = Math.round(pts[k].x), y = Math.round(pts[k].y);
    var dx = Math.max(-127, Math.min(127, x - px)), dy = Math.max(-127, Math.min(127, y - py));
    buf.writeInt8(dx, 4 + (k - 1) * 2); buf.writeInt8(dy, 5 + (k - 1) * 2);
    px += dx; py += dy;
  }
  return buf;
}
function encFood(f) { return [f.id, Math.round(f.x), Math.round(f.y), Math.round(f.r * 2) / 2, f.c]; }
function encPowerups() { return powerups.map(function(pw) { return [pw.id, Math.round(pw.x), Math.round(pw.y), pw.r, pw.type, pw.color, pw.icon]; }); }

var netTick = 0;
setInterval(function() {
  var now = Date.now();
  netTick++;
  // Shared deltas for everyone in the game
  var moved = Object.keys(foodMoved);
  if (foodAdd.length || foodDel.length || moved.length) {
    io.to('game').emit('fd', { a: foodAdd.map(encFood), r: foodDel, m: moved.map(function(id) { var f = foodMoved[id]; return [f.id, Math.round(f.x), Math.round(f.y)]; }) });
    foodAdd = []; foodDel = []; foodMoved = {};
  }
  if (pwDirty) { io.to('game').emit('pw', encPowerups()); pwDirty = false; }

  var alive = Object.values(players).filter(function(p) { return p.alive; });
  // Encode each snake once per tick
  var snakes = alive.map(function(op) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < op.segments.length; i += 3) {
      var sg = op.segments[i];
      if (sg.x < minX) minX = sg.x; if (sg.x > maxX) maxX = sg.x; if (sg.y < minY) minY = sg.y; if (sg.y > maxY) maxY = sg.y;
    }
    var fx = [];
    for (var e in op.effects) if (op.effects[e] > now) fx.push(e);
    return { p: op, box: [minX, minY, maxX, maxY],
      st: { i: op.nid, l: op.segments.length, b: op.boosting && op.segments.length > 10 ? 1 : 0, fx: fx.length ? fx : 0, a: Math.round(op.angle * 100) / 100, d: encodeBody(op.segments) } };
  });
  var sendLb = netTick % LB_EVERY === 0, lb = null, rank = {};
  if (sendLb) {
    alive.sort(function(a, b) { return b.segments.length - a.segments.length; });
    lb = alive.slice(0, 10).map(function(q) { return [q.nid, q.name, q.segments.length, q.isBot ? 1 : 0]; });
    alive.forEach(function(q, i) { rank[q.id] = i + 1; });
  }
  var king = sendLb && alive[0] ? alive[0] : null;

  for (var id in players) {
    var p = players[id];
    if (p.isBot) continue;
    var sock = io.sockets.get(id);
    if (!sock) continue;
    // Who are we looking at? ourselves, or (when dead) whoever got us
    var c;
    if (p.alive) c = p.segments[0];
    else {
      if (!p.deadAt || now - p.deadAt > 120000) continue;
      var w = p.watch && players[p.watch];
      c = w && w.alive ? w.segments[0] : p.deathPos;
    }
    var vw = p.view.w + 60, vh = p.view.h + 60, list = [], meta = null;
    var sent = sock.sentMeta || (sock.sentMeta = {});
    for (var k = 0; k < snakes.length; k++) {
      var sn = snakes[k], bx = sn.box;
      if (bx[2] < c.x - vw || bx[0] > c.x + vw || bx[3] < c.y - vh || bx[1] > c.y + vh) continue;
      list.push(sn.st);
      if (sent[sn.p.nid] === undefined) { sent[sn.p.nid] = 1; (meta || (meta = {}))[sn.p.nid] = [sn.p.name, sn.p.skin, sn.p.isBot ? 1 : 0]; }
    }
    var msg = { me: p.nid, al: p.alive ? 1 : 0, c: [Math.round(c.x), Math.round(c.y)], p: list, sc: p.alive ? p.segments.length : 0, k: p.kills };
    // Names/skins go on the reliable channel: they are only sent once per snake
    if (meta) sock.emit('meta', meta);
    io.volatile.to(id).emit('s', msg);
    if (sendLb) sock.emit('lb', { t: lb, rk: rank[id] || 0, n: alive.length, kg: king ? [king.nid, Math.round(king.segments[0].x), Math.round(king.segments[0].y)] : null });
  }
}, 1000 / NET_TPS);

// ── Sockets ──
io.on('connection', function(socket) {
  socket.emit('cfg', { w: WORLD_W, h: WORLD_H });
  socket.emit('ranking', getTop());
  function spawn(d) {
    d = d || {};
    players[socket.id] = createPlayer(socket.id, cleanName(d.name, 'Gusano'), cleanSkin(d.skin), false);
    // Full copy of the shared world; deltas follow on the 'game' room
    socket.join('game');
    socket.sentMeta = {};
    socket.emit('ff', food.map(encFood));
    socket.emit('pw', encPowerups());
  }
  socket.on('join', spawn);
  socket.on('respawn', spawn);
  socket.on('input', function(d) {
    var p = players[socket.id];
    if (!p || !d) return;
    if (typeof d.vw === 'number' && typeof d.vh === 'number' && isFinite(d.vw) && isFinite(d.vh)) {
      p.view.w = Math.max(300, Math.min(VIEW_MAX, d.vw)); p.view.h = Math.max(300, Math.min(VIEW_MAX, d.vh));
    }
    if (!p.alive) return;
    if (typeof d.angle === 'number' && isFinite(d.angle)) p.targetAngle = d.angle;
    p.boosting = !!d.boost;
  });
  socket.on('disconnect', function() {
    var p = players[socket.id];
    if (p && p.alive) dropFood(p);
    delete players[socket.id];
  });
});

};
