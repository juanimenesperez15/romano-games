module.exports = function(io) {

// ── Config ──
var TPS = 60, NET_TPS = 20;
var MAP = 2000;
var PLAYER_R = 14, PLAYER_SPEED = 2.8, PLAYER_HP = 100;
var LOBBY_TIME = 20, MATCH_TIME = 180; // 3 min match
var SHRINK_INTERVAL = 25;
var MAP_MIN = 400;
var LOOT_COUNT = 60;
var BOT_COUNT = 5;
var botIdCounter = 0;

var WEAPONS = {
  fists:   { name:'Fists',    dmg:10, range:30,  rate:400,  bullets:0, spread:0,   speed:0,  ammo:Infinity, icon:'👊', color:'#aaa' },
  pistol:  { name:'Pistola',  dmg:15, range:500, rate:350,  bullets:1, spread:0.05,speed:12, ammo:20,       icon:'🔫', color:'#F59E0B' },
  shotgun: { name:'Escopeta', dmg:8,  range:250, rate:800,  bullets:5, spread:0.2, speed:10, ammo:10,       icon:'💥', color:'#EF4444' },
  rifle:   { name:'Rifle',    dmg:25, range:700, rate:600,  bullets:1, spread:0.02,speed:16, ammo:15,       icon:'🎯', color:'#3B82F6' },
  sniper:  { name:'Sniper',   dmg:50, range:1000,rate:1200, bullets:1, spread:0,   speed:20, ammo:5,        icon:'🔭', color:'#A78BFA' },
};
var WEAPON_KEYS = ['pistol','shotgun','rifle','sniper'];
var HEAL_AMOUNT = 30;

// ── State ──
var phase = 'lobby'; // lobby | playing | ended
var phaseStart = Date.now();
var mapSize = MAP, mapCenter = MAP / 2;
var lastShrink = 0;
var players = {};
var bullets = [];
var loot = []; // {x,y,type:'pistol'|'shotgun'|...|'heal',id}
var obstacles = []; // {x,y,w,h} - boxes/rocks
var lootId = 0;
var winner = null;

// ── Map generation ──
function genObstacles() {
  obstacles = [];
  // Random boxes
  for (var i = 0; i < 40; i++) {
    var size = 20 + Math.random() * 40;
    obstacles.push({
      x: 100 + Math.random() * (MAP - 200),
      y: 100 + Math.random() * (MAP - 200),
      w: size, h: size,
      hp: 80, color: '#4a3728',
    });
  }
  // Some bigger rocks
  for (var j = 0; j < 15; j++) {
    var rs = 30 + Math.random() * 30;
    obstacles.push({
      x: 100 + Math.random() * (MAP - 200),
      y: 100 + Math.random() * (MAP - 200),
      w: rs, h: rs,
      hp: 999, color: '#555',
    });
  }
}

function spawnLoot() {
  var types = ['pistol','pistol','pistol','shotgun','shotgun','rifle','rifle','sniper','heal','heal','heal'];
  var t = types[Math.floor(Math.random() * types.length)];
  var b = getBounds();
  return {
    x: b.x1 + 50 + Math.random() * (mapSize - 100),
    y: b.y1 + 50 + Math.random() * (mapSize - 100),
    type: t, id: ++lootId,
  };
}

function initLoot() {
  loot = [];
  for (var i = 0; i < LOOT_COUNT; i++) loot.push(spawnLoot());
}

function getBounds() {
  var h = mapSize / 2;
  return { x1: mapCenter - h, y1: mapCenter - h, x2: mapCenter + h, y2: mapCenter + h };
}

function spawnPos() {
  var b = getBounds(), pad = 80;
  return { x: b.x1 + pad + Math.random() * (mapSize - pad * 2), y: b.y1 + pad + Math.random() * (mapSize - pad * 2) };
}

function createPlayer(id, name, isBot) {
  var p = spawnPos();
  return {
    id: id, name: name || 'Jugador', isBot: !!isBot,
    x: p.x, y: p.y, angle: Math.random() * Math.PI * 2,
    vx: 0, vy: 0, speed: PLAYER_SPEED,
    hp: PLAYER_HP, maxHp: PLAYER_HP, alive: true,
    weapon: 'fists', ammo: {}, lastShot: 0,
    kills: 0, spectating: false,
    moveDir: null, // {x,y} normalized or null
    aimAngle: 0, shooting: false,
  };
}

function createBot() {
  var id = 'bot_' + (++botIdCounter);
  var p = createPlayer(id, 'Bot ' + botIdCounter, true);
  // Give bots a random weapon
  var wk = WEAPON_KEYS[Math.floor(Math.random() * WEAPON_KEYS.length)];
  p.weapon = wk;
  p.ammo[wk] = WEAPONS[wk].ammo;
  p.botTarget = null;
  p.botWander = Math.random() * Math.PI * 2;
  p.botWanderT = 0;
  players[id] = p;
  return id;
}

function distSq(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
function dist(a, b) { return Math.sqrt(distSq(a, b)); }

// ── Phase management ──
function startLobby() {
  phase = 'lobby'; phaseStart = Date.now(); winner = null;
  mapSize = MAP; lastShrink = 0;
  genObstacles(); initLoot(); bullets = [];
  for (var id in players) {
    if (players[id].isBot) { delete players[id]; continue; }
    players[id].alive = false; players[id].spectating = false;
  }
  io.emit('phase', { phase: 'lobby', time: LOBBY_TIME });
}

function startMatch() {
  phase = 'playing'; phaseStart = Date.now();
  mapSize = MAP; lastShrink = Date.now();
  genObstacles(); initLoot(); bullets = [];
  // Spawn all humans
  var ids = Object.keys(players);
  for (var i = 0; i < ids.length; i++) {
    var old = players[ids[i]];
    players[ids[i]] = createPlayer(ids[i], old.name, false);
  }
  // Add bots
  var humans = ids.length;
  var botsNeeded = Math.max(0, BOT_COUNT - humans + 1);
  for (var b = 0; b < botsNeeded; b++) createBot();
  io.emit('phase', { phase: 'playing', time: MATCH_TIME });
}

function endMatch(winnerId) {
  phase = 'ended'; phaseStart = Date.now();
  var w = winnerId && players[winnerId] ? players[winnerId] : null;
  winner = w ? { name: w.name, kills: w.kills } : null;
  io.emit('phase', { phase: 'ended', winner: winner });
  setTimeout(startLobby, 8000);
}

function getAlive() {
  var a = [];
  for (var id in players) { if (players[id].alive) a.push(id); }
  return a;
}

startLobby();

// ── Rect collision ──
function rectContains(r, px, py, pr) {
  return px + pr > r.x && px - pr < r.x + r.w && py + pr > r.y && py - pr < r.y + r.h;
}

function lineRect(x1, y1, x2, y2, r) {
  // Check if line segment intersects rectangle
  var dx = x2 - x1, dy = y2 - y1;
  var steps = Math.ceil(Math.sqrt(dx * dx + dy * dy) / 5);
  for (var i = 0; i <= steps; i++) {
    var t = i / steps;
    var px = x1 + dx * t, py = y1 + dy * t;
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return true;
  }
  return false;
}

// ── Bot AI ──
function updateBots() {
  var now = Date.now();
  for (var id in players) {
    var p = players[id];
    if (!p.isBot || !p.alive) continue;

    // Find nearest alive player
    var nearest = null, nearDist = Infinity;
    for (var oid in players) {
      if (oid === id || !players[oid].alive) continue;
      var d = dist(p, players[oid]);
      if (d < nearDist) { nearDist = d; nearest = players[oid]; }
    }

    var wep = WEAPONS[p.weapon] || WEAPONS.fists;

    if (nearest && nearDist < 400) {
      // Chase and shoot
      p.aimAngle = Math.atan2(nearest.y - p.y, nearest.x - p.x);
      if (nearDist > 60) {
        p.moveDir = { x: Math.cos(p.aimAngle), y: Math.sin(p.aimAngle) };
      } else {
        p.moveDir = null;
      }
      // Shoot if in range and has ammo
      if (nearDist < wep.range * 0.8) {
        p.shooting = true;
      } else {
        p.shooting = false;
      }
    } else {
      // Wander
      p.shooting = false;
      if (now - p.botWanderT > 2000 + Math.random() * 2000) {
        p.botWander = Math.random() * Math.PI * 2;
        p.botWanderT = now;
      }
      p.aimAngle = p.botWander;
      p.moveDir = { x: Math.cos(p.botWander) * 0.5, y: Math.sin(p.botWander) * 0.5 };
    }

    // Pick up loot if nearby
    for (var li = loot.length - 1; li >= 0; li--) {
      if (dist(p, loot[li]) < 30) {
        pickupLoot(p, li);
        break;
      }
    }

    // Switch to better weapon if has ammo
    for (var wi = WEAPON_KEYS.length - 1; wi >= 0; wi--) {
      var wk = WEAPON_KEYS[wi];
      if (p.ammo[wk] && p.ammo[wk] > 0) { p.weapon = wk; break; }
    }
  }
}

function pickupLoot(p, idx) {
  var item = loot[idx];
  if (item.type === 'heal') {
    p.hp = Math.min(p.maxHp, p.hp + HEAL_AMOUNT);
  } else {
    var wep = WEAPONS[item.type];
    if (wep) {
      p.ammo[item.type] = (p.ammo[item.type] || 0) + wep.ammo;
      if (p.weapon === 'fists') p.weapon = item.type;
    }
  }
  loot.splice(idx, 1);
}

function killPlayer(victim, killerId) {
  victim.alive = false;
  victim.spectating = true;
  if (killerId && players[killerId]) players[killerId].kills++;
  // Drop loot
  if (victim.weapon !== 'fists') {
    loot.push({ x: victim.x, y: victim.y, type: victim.weapon, id: ++lootId });
  }
  loot.push({ x: victim.x + 15, y: victim.y, type: 'heal', id: ++lootId });
  io.to(victim.id).emit('dead', { killer: killerId && players[killerId] ? players[killerId].name : 'Zona' });
}

// ── Physics ──
setInterval(function() {
  var now = Date.now();

  if (phase === 'lobby') {
    if ((now - phaseStart) / 1000 >= LOBBY_TIME && Object.keys(players).length >= 1) {
      startMatch();
    }
    return;
  }
  if (phase !== 'playing') return;

  // Time check
  if ((now - phaseStart) / 1000 >= MATCH_TIME) {
    var alive = getAlive();
    var best = null, bestKills = -1;
    for (var ai = 0; ai < alive.length; ai++) {
      if (players[alive[ai]].kills > bestKills) { bestKills = players[alive[ai]].kills; best = alive[ai]; }
    }
    endMatch(best);
    return;
  }

  // Shrink
  if (now - lastShrink >= SHRINK_INTERVAL * 1000 && lastShrink > 0) {
    lastShrink = now;
    var totalShrinks = Math.floor(MATCH_TIME / SHRINK_INTERVAL);
    var amount = (MAP - MAP_MIN) / totalShrinks;
    mapSize = Math.max(MAP_MIN, mapSize - amount);
    // Remove loot outside
    var b = getBounds();
    loot = loot.filter(function(l) { return l.x >= b.x1 && l.x <= b.x2 && l.y >= b.y1 && l.y <= b.y2; });
    io.emit('shrink', {});
  }
  if (lastShrink === 0) lastShrink = now;

  var bounds = getBounds();

  // Bot AI
  updateBots();

  // Move players
  for (var id in players) {
    var p = players[id];
    if (!p.alive) continue;

    if (p.moveDir) {
      var nx = p.x + p.moveDir.x * p.speed;
      var ny = p.y + p.moveDir.y * p.speed;

      // Obstacle collision
      var blocked = false;
      for (var oi = 0; oi < obstacles.length; oi++) {
        if (rectContains(obstacles[oi], nx, ny, PLAYER_R)) { blocked = true; break; }
      }
      if (!blocked) { p.x = nx; p.y = ny; }
    }

    // Zone damage
    if (p.x < bounds.x1 || p.x > bounds.x2 || p.y < bounds.y1 || p.y > bounds.y2) {
      p.hp -= 1; // 1 damage per tick outside zone
      if (p.hp <= 0) { killPlayer(p, null); }
    }

    // Clamp to not go too far outside
    p.x = Math.max(bounds.x1 - 100, Math.min(bounds.x2 + 100, p.x));
    p.y = Math.max(bounds.y1 - 100, Math.min(bounds.y2 + 100, p.y));

    // Shooting
    if (p.shooting) {
      var wep = WEAPONS[p.weapon];
      if (wep && now - p.lastShot >= wep.rate) {
        if (p.weapon === 'fists') {
          // Melee - hit nearby players
          for (var mid in players) {
            if (mid === id || !players[mid].alive) continue;
            if (dist(p, players[mid]) < wep.range + PLAYER_R) {
              players[mid].hp -= wep.dmg;
              if (players[mid].hp <= 0) killPlayer(players[mid], id);
            }
          }
          p.lastShot = now;
        } else if ((p.ammo[p.weapon] || 0) > 0) {
          p.ammo[p.weapon]--;
          for (var bi = 0; bi < wep.bullets; bi++) {
            var spread = (Math.random() - 0.5) * wep.spread * 2;
            var angle = p.aimAngle + spread;
            bullets.push({
              x: p.x + Math.cos(angle) * 20, y: p.y + Math.sin(angle) * 20,
              vx: Math.cos(angle) * wep.speed, vy: Math.sin(angle) * wep.speed,
              dmg: wep.dmg, owner: id, life: wep.range / wep.speed,
              born: now,
            });
          }
          p.lastShot = now;
          if (p.ammo[p.weapon] <= 0) {
            // Switch to another weapon with ammo
            p.weapon = 'fists';
            for (var wi = 0; wi < WEAPON_KEYS.length; wi++) {
              if (p.ammo[WEAPON_KEYS[wi]] > 0) { p.weapon = WEAPON_KEYS[wi]; break; }
            }
          }
        }
      }
    }

    // Auto pickup loot
    for (var li = loot.length - 1; li >= 0; li--) {
      if (dist(p, loot[li]) < 25) {
        pickupLoot(p, li);
      }
    }
  }

  // Move bullets
  for (var bii = bullets.length - 1; bii >= 0; bii--) {
    var bl = bullets[bii];
    bl.x += bl.vx; bl.y += bl.vy;
    bl.life--;

    if (bl.life <= 0) { bullets.splice(bii, 1); continue; }

    // Hit players
    var hit = false;
    for (var pid in players) {
      if (pid === bl.owner || !players[pid].alive) continue;
      if (distSq(bl, players[pid]) < (PLAYER_R + 4) * (PLAYER_R + 4)) {
        players[pid].hp -= bl.dmg;
        if (players[pid].hp <= 0) killPlayer(players[pid], bl.owner);
        hit = true; break;
      }
    }
    if (hit) { bullets.splice(bii, 1); continue; }

    // Hit obstacles
    for (var oii = 0; oii < obstacles.length; oii++) {
      var ob = obstacles[oii];
      if (bl.x >= ob.x && bl.x <= ob.x + ob.w && bl.y >= ob.y && bl.y <= ob.y + ob.h) {
        ob.hp -= bl.dmg;
        if (ob.hp <= 0) obstacles.splice(oii, 1);
        hit = true; break;
      }
    }
    if (hit) { bullets.splice(bii, 1); continue; }
  }

  // Check winner
  var alive = getAlive();
  var humanAlive = alive.filter(function(id) { return !players[id].isBot; });
  if (alive.length <= 1) {
    endMatch(alive[0]);
  } else if (humanAlive.length === 0 && alive.length > 0) {
    endMatch(alive[0]); // All humans dead
  }

  // Respawn loot occasionally
  if (loot.length < 20 && Math.random() < 0.02) loot.push(spawnLoot());

}, 1000 / TPS);

// ── Network ──
setInterval(function() {
  if (phase === 'ended') return;
  var now = Date.now();
  var elapsed = Math.floor((now - phaseStart) / 1000);
  var timeLeft = (phase === 'lobby' ? LOBBY_TIME : MATCH_TIME) - elapsed;
  var bounds = getBounds();
  var aliveCount = getAlive().length;

  for (var id in players) {
    var p = players[id];
    // Camera: own pos if alive, or first alive
    var cam = p.alive ? p : null;
    if (!cam) {
      for (var cid in players) { if (players[cid].alive) { cam = players[cid]; break; } }
    }
    if (!cam) cam = { x: mapCenter, y: mapCenter };

    var vd = 600;
    // Nearby players
    var np = [];
    for (var oid in players) {
      var op = players[oid];
      if (!op.alive) continue;
      if (Math.abs(op.x - cam.x) < vd && Math.abs(op.y - cam.y) < vd) {
        np.push({
          x: Math.round(op.x), y: Math.round(op.y), a: Math.round(op.aimAngle * 100) / 100,
          hp: op.hp, mhp: op.maxHp, n: op.name, w: op.weapon,
          me: oid === id ? 1 : 0, bot: op.isBot ? 1 : 0,
        });
      }
    }
    // Nearby bullets
    var nb = [];
    for (var bi = 0; bi < bullets.length; bi++) {
      var bl = bullets[bi];
      if (Math.abs(bl.x - cam.x) < vd && Math.abs(bl.y - cam.y) < vd) {
        nb.push({ x: Math.round(bl.x), y: Math.round(bl.y) });
      }
    }
    // Nearby loot
    var nl = [];
    for (var li = 0; li < loot.length; li++) {
      var lo = loot[li];
      if (Math.abs(lo.x - cam.x) < vd && Math.abs(lo.y - cam.y) < vd) {
        nl.push({ x: Math.round(lo.x), y: Math.round(lo.y), t: lo.type });
      }
    }
    // Nearby obstacles
    var no = [];
    for (var oi = 0; oi < obstacles.length; oi++) {
      var ob = obstacles[oi];
      if (Math.abs(ob.x + ob.w / 2 - cam.x) < vd + ob.w && Math.abs(ob.y + ob.h / 2 - cam.y) < vd + ob.h) {
        no.push({ x: Math.round(ob.x), y: Math.round(ob.y), w: Math.round(ob.w), h: Math.round(ob.h), c: ob.color });
      }
    }

    io.volatile.to(id).emit('s', {
      p: np, b: nb, l: nl, o: no,
      ph: phase, tl: Math.max(0, timeLeft), ac: aliveCount,
      ms: Math.round(mapSize), mc: mapCenter,
      bx1: Math.round(bounds.x1), by1: Math.round(bounds.y1),
      bx2: Math.round(bounds.x2), by2: Math.round(bounds.y2),
      me: p.alive ? { hp: p.hp, mhp: p.maxHp, w: p.weapon, ammo: p.ammo[p.weapon] || 0, k: p.kills } : null,
      spec: p.spectating ? 1 : 0,
    });
  }
}, 1000 / NET_TPS);

// ── Sockets ──
io.on('connection', function(socket) {
  socket.emit('phase', { phase: phase, time: Math.max(0, Math.floor(((phase === 'lobby' ? LOBBY_TIME : MATCH_TIME) * 1000 - (Date.now() - phaseStart)) / 1000)) });

  socket.on('join', function(data) {
    var name = (data.name || 'Jugador').substring(0, 12);
    if (phase === 'lobby') {
      players[socket.id] = createPlayer(socket.id, name, false);
      players[socket.id].alive = false; // Wait for match
    } else {
      // Spectate
      players[socket.id] = createPlayer(socket.id, name, false);
      players[socket.id].alive = false;
      players[socket.id].spectating = true;
      socket.emit('spectate', {});
    }
  });

  socket.on('input', function(data) {
    var p = players[socket.id];
    if (!p || !p.alive) return;
    if (data.mx !== undefined && data.my !== undefined) {
      var len = Math.sqrt(data.mx * data.mx + data.my * data.my);
      if (len > 0.1) {
        p.moveDir = { x: data.mx / len, y: data.my / len };
      } else {
        p.moveDir = null;
      }
    } else {
      p.moveDir = null;
    }
    if (typeof data.aa === 'number') p.aimAngle = data.aa;
    p.shooting = !!data.sh;
  });

  socket.on('weapon', function(data) {
    var p = players[socket.id];
    if (!p || !p.alive) return;
    if (data.w && WEAPONS[data.w] && (p.ammo[data.w] > 0 || data.w === 'fists')) {
      p.weapon = data.w;
    }
  });

  socket.on('disconnect', function() {
    var p = players[socket.id];
    if (p && p.alive) {
      // Drop loot
      if (p.weapon !== 'fists') loot.push({ x: p.x, y: p.y, type: p.weapon, id: ++lootId });
    }
    delete players[socket.id];
  });
});

};
