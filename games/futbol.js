module.exports = function(io) {

// ── Config ──
var TPS = 60, NET_TPS = 30;
var PLAYER_R = 15, BALL_R = 10, POST_R = 7;
var ACCEL = 0.11, CHARGE_ACCEL = 0.07, DAMP = 0.96;      // player: top speed ≈ ACCEL / (1 - DAMP)
var BALL_DAMP = 0.99, BALL_MAX = 13;
var KICK_MIN = 4.2, KICK_MAX = 10.5, CHARGE_TICKS = 55;   // hold kick to charge up to ~1s
var REACH = PLAYER_R + BALL_R + 5;
var BOUNCE_BALL = 0.55, BOUNCE_PLAYER = 0.4, BOUNCE_DISC = 0.5;
var OUT_MARGIN = 45, GOAL_DEPTH = 34, KICKOFF_CIRCLE = 75;
var GOAL_PAUSE = 3.2, END_PAUSE = 12, PUBLIC_LOBBY = 20;
var ASSIST_WINDOW = 8000;
var GOLDEN_MAX = 90;                 // s of golden goal before calling it a draw
var PUBLIC_CODE = 'PUBLICA';
var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
var BOT_NAMES = ['Bot Cacho', 'Bot Tito', 'Bot Pipo', 'Bot Rulo', 'Bot Chacho', 'Bot Coco', 'Bot Pocho', 'Bot Lalo'];
var QUICK = ['¡Pasala!', '¡Qué golazo!', 'Uff…', '¡Vamos!', 'Perdón 😅', '¡Atajá!'];
// Pitch size by players per team
var SIZES = { 1: [720, 400, 120], 2: [860, 460, 136], 3: [1000, 540, 150], 4: [1140, 610, 164] };

var rooms = {};

function now() { return Date.now(); }
function clean(n) { return String(n || 'Jugador').replace(/[<>&"'`]/g, '').trim().substring(0, 12) || 'Jugador'; }
function len(x, y) { return Math.sqrt(x * x + y * y); }
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// ── Rooms ──
function newCode() {
  var c;
  do { c = ''; for (var i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]; } while (rooms[c]);
  return c;
}

function createRoom(code, isPublic) {
  var r = {
    code: code, isPublic: isPublic, players: {}, host: null,
    teamSize: 3, duration: 180,
    phase: 'lobby', phaseStart: now(), lobbyStart: 0,
    score: { red: 0, blue: 0 }, timeLeft: 180, golden: false,
    ball: null, touches: [], kickoffTeam: 'red', kickoffFree: true,
    lastSay: 0, dribble: null, lastShot: null, lastMinuteSaid: false,
    botCounter: 0, tick: 0,
  };
  setPitch(r);
  rooms[code] = r;
  return r;
}

function setPitch(r) {
  var s = SIZES[r.teamSize];
  r.W = s[0]; r.H = s[1]; r.G = s[2] / 2; r.cy = r.H / 2;
}

function humans(r) { return Object.keys(r.players).filter(function(id) { return !r.players[id].isBot; }).map(function(id) { return r.players[id]; }); }
function teamList(r, team) { return Object.keys(r.players).map(function(id) { return r.players[id]; }).filter(function(p) { return p.team === team; }); }

function newPlayer(id, name, isBot, team) {
  return { id: id, name: name, isBot: isBot, team: team, x: 0, y: 0, vx: 0, vy: 0,
    ix: 0, iy: 0, kickHeld: false, charge: 0, botKick: 0, role: 'field', quick: null, quickUntil: 0, lastQuick: 0,
    stats: { goals: 0, assists: 0, shots: 0, kicks: 0, own: 0 } };
}

function say(r, text, force) {
  var t = now();
  if (!force && t - r.lastSay < 2600) return;
  r.lastSay = t;
  io.to(r.code).emit('say', { t: text });
}

// Humans pick their team; bots fill the rest up to teamSize per side
function fillBots(r) {
  ['red', 'blue'].forEach(function(team) {
    var list = teamList(r, team), hum = list.filter(function(p) { return !p.isBot; }), bots = list.filter(function(p) { return p.isBot; });
    var want = Math.max(0, r.teamSize - hum.length);
    while (bots.length > want) { delete r.players[bots.pop().id]; }
    while (bots.length < want) {
      var used = {}; for (var id in r.players) used[r.players[id].name] = true;
      var name = BOT_NAMES.filter(function(n) { return !used[n]; })[0] || 'Bot';
      var b = newPlayer('bot_' + r.code + '_' + (++r.botCounter), name, true, team);
      r.players[b.id] = b; bots.push(b);
    }
  });
  assignRoles(r);
}

function assignRoles(r) {
  ['red', 'blue'].forEach(function(team) {
    var list = teamList(r, team);
    // Keeper is a bot when possible (humans want to play up front)
    var bots = list.filter(function(p) { return p.isBot; });
    list.forEach(function(p) { p.role = 'field'; });
    if (list.length >= 2) (bots[0] || list[list.length - 1]).role = 'keeper';
    var field = list.filter(function(p) { return p.role === 'field'; });
    field.forEach(function(p, i) { p.role = i === 0 ? 'field' : i % 2 ? 'defender' : 'wing'; });
  });
}

function balanceTeam(r) {
  var red = teamList(r, 'red').filter(function(p) { return !p.isBot; }).length;
  var blue = teamList(r, 'blue').filter(function(p) { return !p.isBot; }).length;
  return red <= blue ? 'red' : 'blue';
}

// ── Match flow ──
function setPhase(r, ph) { r.phase = ph; r.phaseStart = now(); io.to(r.code).emit('phase', { phase: ph }); }

function resetPositions(r) {
  var W = r.W, H = r.H;
  r.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
  ['red', 'blue'].forEach(function(team) {
    var list = teamList(r, team), dir = team === 'red' ? -1 : 1;
    var field = list.filter(function(p) { return p.role !== 'keeper'; });
    list.forEach(function(p) {
      p.vx = p.vy = 0; p.charge = 0;
      if (p.role === 'keeper') { p.x = W / 2 + dir * (W / 2 - 30); p.y = H / 2; }
    });
    field.forEach(function(p, i) {
      var n = field.length;
      p.x = W / 2 + dir * (i === 0 ? KICKOFF_CIRCLE + 40 : W * 0.28);
      p.y = n === 1 ? H / 2 : i === 0 ? H / 2 : H * (0.25 + 0.5 * ((i - 1) / Math.max(1, n - 2)));
      if (n === 2 && i === 1) p.y = H / 2 + (Math.random() < 0.5 ? -1 : 1) * H * 0.22;
    });
  });
  r.kickoffFree = false; r.touches = []; r.dribble = null; r.lastShot = null;
}

function startMatch(r) {
  fillBots(r);
  r.score = { red: 0, blue: 0 };
  r.timeLeft = r.duration; r.golden = false; r.lastMinuteSaid = false;
  for (var id in r.players) r.players[id].stats = { goals: 0, assists: 0, shots: 0, kicks: 0, own: 0 };
  r.kickoffTeam = Math.random() < 0.5 ? 'red' : 'blue';
  resetPositions(r);
  setPhase(r, 'kickoff');
  io.to(r.code).emit('sfx', { t: 'whistle' });
  say(r, pick(['¡Arranca el partido! Rueda la pelota…', '¡Pita el árbitro y arrancamos!', '¡Empieza el partido de Romano!']), true);
}

function goal(r, scoringTeam) {
  r.score[scoringTeam]++;
  var last = r.touches[r.touches.length - 1];
  var scorer = last && r.players[last.id], assist = null, own = false, text;
  if (scorer && scorer.team !== scoringTeam) {
    own = true; scorer.stats.own++;
    text = pick(['¡En contra! ', '¡Qué desgracia! ', '¡Gol en contra! ']) + scorer.name + ' la metió en su propio arco';
  } else if (scorer) {
    scorer.stats.goals++;
    for (var i = r.touches.length - 2; i >= 0; i--) {
      var t = r.touches[i];
      if (t.id === scorer.id) continue;
      if (t.team === scoringTeam && now() - t.at < ASSIST_WINDOW && r.players[t.id]) { assist = r.players[t.id]; assist.stats.assists++; }
      break;
    }
    text = pick(['¡GOOOOOL de ', '¡GOLAZO de ', '¡La mandó a guardar ', '¡Adentro! Gol de ']) + scorer.name + '!' +
      (assist ? pick([' Qué pase de ', ' Asistencia de ', ' Se la dejó servida ']) + assist.name + '.' : '');
  } else text = '¡GOOOOL!';
  io.to(r.code).emit('goal', {
    team: scoringTeam, scorer: scorer ? scorer.name : null, assist: assist ? assist.name : null, own: own,
    score: r.score, x: r.ball.x, y: r.ball.y,
  });
  say(r, text, true);
  r.kickoffTeam = scoringTeam === 'red' ? 'blue' : 'red';
  if (r.golden) { endMatch(r); return; }
  setPhase(r, 'goal');
}

function endMatch(r) {
  var all = Object.keys(r.players).map(function(id) { return r.players[id]; });
  all.forEach(function(p) { p.stats.score = p.stats.goals * 3 + p.stats.assists * 2 + p.stats.shots * 0.6 + p.stats.kicks * 0.05 - p.stats.own * 2; });
  var mvp = all.slice().sort(function(a, b) { return b.stats.score - a.stats.score; })[0];
  var winner = r.score.red > r.score.blue ? 'red' : r.score.blue > r.score.red ? 'blue' : null;
  io.to(r.code).emit('end', {
    score: r.score, winner: winner, mvp: mvp ? mvp.name : null,
    stats: all.map(function(p) { return { n: p.name, t: p.team, b: p.isBot ? 1 : 0, g: p.stats.goals, a: p.stats.assists, s: p.stats.shots, o: p.stats.own }; }),
  });
  io.to(r.code).emit('sfx', { t: 'end' });
  say(r, winner ? '¡Terminó! Ganó el ' + (winner === 'red' ? 'Rojo' : 'Azul') + ' ' + Math.max(r.score.red, r.score.blue) + ' a ' + Math.min(r.score.red, r.score.blue) : '¡Terminó! Empate', true);
  setPhase(r, 'ended');
}

// ── Physics ──
function collideDiscs(a, b, ima, imb, bounce) {
  var dx = b.x - a.x, dy = b.y - a.y, d = len(dx, dy), rr = a.r + b.r;
  if (d >= rr || d === 0) return false;
  var nx = dx / d, ny = dy / d, over = rr - d, tot = ima + imb;
  a.x -= nx * over * ima / tot; a.y -= ny * over * ima / tot;
  b.x += nx * over * imb / tot; b.y += ny * over * imb / tot;
  var rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rv < 0) {
    var j = -(1 + bounce) * rv / tot;
    a.vx -= j * ima * nx; a.vy -= j * ima * ny;
    b.vx += j * imb * nx; b.vy += j * imb * ny;
  }
  return true;
}

// Disc vs segment (x1,y1)-(x2,y2)
function collideSeg(o, r, x1, y1, x2, y2, bounce) {
  var sx = x2 - x1, sy = y2 - y1, l2 = sx * sx + sy * sy;
  var t = clamp(((o.x - x1) * sx + (o.y - y1) * sy) / l2, 0, 1);
  var px = x1 + sx * t, py = y1 + sy * t, dx = o.x - px, dy = o.y - py, d = len(dx, dy);
  if (d >= r || d === 0) return false;
  var nx = dx / d, ny = dy / d;
  o.x = px + nx * r; o.y = py + ny * r;
  var vn = o.vx * nx + o.vy * ny;
  if (vn < 0) { o.vx -= (1 + bounce) * vn * nx; o.vy -= (1 + bounce) * vn * ny; }
  return true;
}

function netWalls(r) {
  var W = r.W, cy = r.cy, G = r.G, D = GOAL_DEPTH;
  return [
    [0, cy - G, -D, cy - G], [-D, cy - G, -D, cy + G], [-D, cy + G, 0, cy + G],
    [W, cy - G, W + D, cy - G], [W + D, cy - G, W + D, cy + G], [W + D, cy + G, W, cy + G],
  ];
}
function posts(r) { return [[0, r.cy - r.G], [0, r.cy + r.G], [r.W, r.cy - r.G], [r.W, r.cy + r.G]]; }

function doKick(r, p, power, ang) {
  var b = r.ball, dx = b.x - p.x, dy = b.y - p.y, d = len(dx, dy);
  if (d > REACH || d === 0) return false;
  var nx = dx / d, ny = dy / d;
  if (ang !== undefined) { nx = Math.cos(ang); ny = Math.sin(ang); }
  b.vx += nx * power; b.vy += ny * power;
  var sp = len(b.vx, b.vy); if (sp > BALL_MAX) { b.vx *= BALL_MAX / sp; b.vy *= BALL_MAX / sp; }
  p.stats.kicks++;
  touch(r, p);
  io.to(r.code).emit('sfx', { t: 'kick', p: Math.round(power) });
  // Shot on goal?
  var goalX = p.team === 'red' ? r.W : 0;
  if ((goalX - b.x) * b.vx > 0 && Math.abs(goalX - b.x) < r.W * 0.6) {
    var tt = (goalX - b.x) / b.vx, yAt = b.y + b.vy * tt;
    if (Math.abs(yAt - r.cy) < r.G * 1.25) {
      p.stats.shots++;
      r.lastShot = { id: p.id, team: p.team, at: now() };
      if (power > 8) say(r, pick(['¡Remate de ', '¡Sacó un misil ', '¡Le pegó con todo ']) + p.name + '!');
    }
  }
  return true;
}

function touch(r, p) {
  var last = r.touches[r.touches.length - 1];
  // A save: the keeper's team touches it right after a shot at their goal
  if (r.lastShot && p.team !== r.lastShot.team && now() - r.lastShot.at < 1500) {
    if (p.role === 'keeper' || Math.abs(p.x - (p.team === 'red' ? 0 : r.W)) < 120) {
      say(r, pick(['¡Atajadón de ', '¡Qué atajada de ', '¡La sacó ', '¡Salvó el gol ']) + p.name + '!');
      io.to(r.code).emit('sfx', { t: 'ooh' });
    }
    r.lastShot = null;
  }
  if (!last || last.id !== p.id) r.touches.push({ id: p.id, team: p.team, at: now() });
  else last.at = now();
  if (r.touches.length > 12) r.touches.shift();
  if (r.phase === 'kickoff') { r.kickoffFree = true; setPhase(r, 'playing'); }
}

function step(r) {
  var W = r.W, H = r.H, b = r.ball, list = Object.keys(r.players).map(function(id) { return r.players[id]; });
  var kickoff = r.phase === 'kickoff';

  for (var i = 0; i < list.length; i++) {
    var p = list[i];
    if (p.team !== 'red' && p.team !== 'blue') continue;
    if (p.isBot) botThink(r, p);
    var ix = p.ix, iy = p.iy, il = len(ix, iy);
    if (il > 1) { ix /= il; iy /= il; }
    var acc = p.kickHeld ? CHARGE_ACCEL : ACCEL;
    p.vx = (p.vx + ix * acc) * DAMP; p.vy = (p.vy + iy * acc) * DAMP;
    p.x += p.vx; p.y += p.vy;
    // Kick: charge while held, fire on release (bots fire directly)
    if (p.kickHeld) p.charge = Math.min(CHARGE_TICKS, p.charge + 1);
    if (p.kickRelease) {
      p.kickRelease = false;
      doKick(r, p, KICK_MIN + (KICK_MAX - KICK_MIN) * (p.charge / CHARGE_TICKS));
      p.charge = 0;
    }
    if (p.botKick) { doKick(r, p, p.botKick, p.botKickAng); p.botKick = 0; }
    // Bounds
    p.x = clamp(p.x, PLAYER_R - OUT_MARGIN, W + OUT_MARGIN - PLAYER_R);
    p.y = clamp(p.y, PLAYER_R - OUT_MARGIN, H + OUT_MARGIN - PLAYER_R);
    if (kickoff) {
      // Stay in your half; only the kicking team may enter the centre circle
      if (p.team === 'red') p.x = Math.min(p.x, W / 2 - PLAYER_R); else p.x = Math.max(p.x, W / 2 + PLAYER_R);
      if (p.team !== r.kickoffTeam) {
        var dx = p.x - W / 2, dy = p.y - H / 2, d = len(dx, dy), minD = KICKOFF_CIRCLE + PLAYER_R;
        if (d < minD) { if (d === 0) { dx = p.team === 'red' ? -1 : 1; d = 1; } p.x = W / 2 + dx / d * minD; p.y = H / 2 + dy / d * minD; }
      }
    }
  }

  // Player vs player, player vs ball, player vs posts / nets
  var pp = list.filter(function(p) { return p.team === 'red' || p.team === 'blue'; });
  pp.forEach(function(p) { p.r = PLAYER_R; });
  b.r = BALL_R;
  for (var a = 0; a < pp.length; a++) for (var c = a + 1; c < pp.length; c++) collideDiscs(pp[a], pp[c], 1, 1, BOUNCE_DISC);
  for (var k = 0; k < pp.length; k++) if (collideDiscs(pp[k], b, 0.5, 1, BOUNCE_DISC)) touch(r, pp[k]);
  var nets = netWalls(r), ps = posts(r);
  pp.forEach(function(p) {
    nets.forEach(function(w) { collideSeg(p, PLAYER_R, w[0], w[1], w[2], w[3], BOUNCE_PLAYER); });
    ps.forEach(function(q) { collideDiscs({ x: q[0], y: q[1], vx: 0, vy: 0, r: POST_R }, p, 0, 1, BOUNCE_PLAYER); });
  });

  // Ball
  b.vx *= BALL_DAMP; b.vy *= BALL_DAMP;
  b.x += b.vx; b.y += b.vy;
  var cy = r.cy, G = r.G;
  var inMouth = Math.abs(b.y - cy) < G;
  if (b.y - BALL_R < 0) { b.y = BALL_R; b.vy = Math.abs(b.vy) * BOUNCE_BALL; }
  if (b.y + BALL_R > H) { b.y = H - BALL_R; b.vy = -Math.abs(b.vy) * BOUNCE_BALL; }
  if (!inMouth && b.x - BALL_R < 0 && b.x > -BALL_R * 2) { b.x = BALL_R; b.vx = Math.abs(b.vx) * BOUNCE_BALL; }
  if (!inMouth && b.x + BALL_R > W && b.x < W + BALL_R * 2) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx) * BOUNCE_BALL; }
  nets.forEach(function(w) { collideSeg(b, BALL_R, w[0], w[1], w[2], w[3], 0.2); });
  ps.forEach(function(q) {
    var sp = len(b.vx, b.vy);
    if (collideDiscs({ x: q[0], y: q[1], vx: 0, vy: 0, r: POST_R }, b, 0, 1, 0.7) && sp > 3) {
      io.to(r.code).emit('sfx', { t: 'post' });
      say(r, pick(['¡Pegó en el palo!', '¡Uhhh, el palo!', '¡Se salvó! Dio en el poste']));
    }
  });

  // Goal: ball completely over the line inside the mouth
  if (b.x < -BALL_R && Math.abs(b.y - cy) < G + BALL_R) { goal(r, 'blue'); return; }
  if (b.x > W + BALL_R && Math.abs(b.y - cy) < G + BALL_R) { goal(r, 'red'); return; }

  // Commentary: someone running with the ball into the opponent's half
  var last = r.touches[r.touches.length - 1];
  if (last && now() - last.at < 400) {
    var lp = r.players[last.id];
    if (lp && (!r.dribble || r.dribble.id !== lp.id)) r.dribble = { id: lp.id, since: now(), said: false };
    if (lp && r.dribble && !r.dribble.said && now() - r.dribble.since > 1800 && (lp.team === 'red' ? b.x > W * 0.55 : b.x < W * 0.45)) {
      r.dribble.said = true;
      say(r, pick([lp.name + ' encara, se saca uno de encima… ¡ojo que llega!', '¡Va ' + lp.name + ' con todo!', lp.name + ' la pisa, amaga… ¡cuidado!', '¡Qué jugada de ' + lp.name + '!']));
    }
  } else r.dribble = null;
}

// ── Bots ──
function botThink(r, p) {
  var b = r.ball, W = r.W, H = r.H, cy = r.cy;
  var attackX = p.team === 'red' ? W : 0, ownX = p.team === 'red' ? 0 : W, dir = p.team === 'red' ? 1 : -1;
  var tx, ty, wantKick = false, power = 0;
  var mates = teamList(r, p.team).filter(function(q) { return q !== p; });
  var foes = teamList(r, p.team === 'red' ? 'blue' : 'red');
  var dBall = len(b.x - p.x, b.y - p.y);
  var chaser = teamList(r, p.team).filter(function(q) { return q.role !== 'keeper'; })
    .sort(function(a, c) { return len(b.x - a.x, b.y - a.y) - len(b.x - c.x, b.y - c.y); })[0];
  // Lead the ball more the farther away it is
  var lead = Math.min(28, 4 + dBall / 12), bx = clamp(b.x + b.vx * lead, 0, W), by = clamp(b.y + b.vy * lead, 0, H);

  if (r.phase === 'kickoff' && r.kickoffTeam !== p.team) { p.ix = p.iy = 0; return; }

  if (p.role === 'keeper') {
    // Tracks the ball with a lag; comes out only when it is really close
    var want = clamp(cy + (b.y - cy) * 0.45, cy - r.G + 8, cy + r.G - 8);
    p.gy = p.gy === undefined ? cy : p.gy + (want - p.gy) * 0.045;
    tx = ownX + dir * 24; ty = p.gy;
    if (Math.abs(b.x - ownX) < W * 0.16 && dBall < 70) { tx = bx; ty = by; wantKick = true; power = 9; }
  } else if (p === chaser) {
    // Aim at the side of the goal away from the keeper
    if (!p.aimUntil || now() > p.aimUntil) {
      var kp = foes.filter(function(q) { return q.role === 'keeper'; })[0];
      p.aimY = kp ? (kp.y < cy ? cy + r.G * 0.72 : cy - r.G * 0.72) : cy + (Math.random() - 0.5) * r.G;
      p.aimUntil = now() + 700;
    }
    var gx = attackX - bx, gy = p.aimY - by, gl = len(gx, gy) || 1;
    gx /= gl; gy /= gl;
    var ahead = (p.x - bx) * gx + (p.y - by) * gy;
    if (ahead > -PLAYER_R) {
      // Wrong side of the ball: loop around it with room to spare
      var side = ((p.y - by) * gx - (p.x - bx) * gy) > 0 ? 1 : -1;
      tx = bx - gx * 26 - gy * side * (PLAYER_R + BALL_R + 22);
      ty = by - gy * 26 + gx * side * (PLAYER_R + BALL_R + 22);
    } else {
      tx = bx - gx * (PLAYER_R + BALL_R - 6); ty = by - gy * (PLAYER_R + BALL_R - 6);
      if (dBall < REACH) {
        var ax = (b.x - p.x) / dBall, ay = (b.y - p.y) / dBall, align = ax * gx + ay * gy;
        var distGoal = len(attackX - b.x, p.aimY - b.y);
        if (align > 0.95 && distGoal < Math.max(W * 0.45, 440)) { wantKick = true; power = distGoal < W * 0.3 ? KICK_MAX : 9; }
        else if (align > 0.8 && Math.abs(b.x - ownX) < W * 0.5 && Math.random() < 0.1) { wantKick = true; power = 8; }   // long ball forward
        else if (align > 0.6) {
          // Under pressure: pass forward or just boot it
          var pressure = foes.some(function(o) { return len(o.x - b.x, o.y - b.y) < 50; });
          var mate = mates.filter(function(q) { return q.role !== 'keeper' && (q.x - p.x) * dir > 30; })[0];
          if (pressure && mate && Math.random() < 0.4) {
            // Re-aim towards the mate next frames
            p.aimY = clamp(mate.y, 20, H - 20); p.aimUntil = now() + 500;
          } else if (pressure) { wantKick = true; power = 7; }
        }
      }
    }
  } else {
    if (p.role === 'defender') { tx = ownX + dir * W * 0.2 + (b.x - ownX) * 0.3; ty = cy + (b.y - cy) * 0.55; }
    else { tx = clamp(b.x + dir * W * 0.2, 40, W - 40); ty = b.y < cy ? cy + H * 0.22 : cy - H * 0.22; }
    // Clear it if it comes to us, but never towards our own goal
    if (dBall < REACH && (b.x - p.x) * dir > 0) { wantKick = true; power = 7; }
  }

  var mx = tx - p.x, my = ty - p.y, ml = len(mx, my);
  if (ml > 3) { var sp = Math.min(1, ml / 25); p.ix = mx / ml * sp; p.iy = my / ml * sp; } else { p.ix = p.iy = 0; }

  if (wantKick && dBall < REACH && r.tick % 4 === 0) {
    // Never kick towards our own goal when defending
    if ((b.x - p.x) * dir < -2 && Math.abs(b.x - ownX) < W * 0.4) return;
    // Aim noise: bots are not perfect
    var ang = Math.atan2(b.y - p.y, b.x - p.x) + (Math.random() - 0.5) * 0.06;
    p.botKick = power; p.botKickAng = ang;
  }
}

// ── Main loop ──
setInterval(function() {
  var t = now();
  for (var code in rooms) {
    var r = rooms[code], el = (t - r.phaseStart) / 1000;
    r.tick++;
    if (r.phase === 'lobby') {
      if (r.isPublic && humans(r).length > 0) {
        if (!r.lobbyStart) r.lobbyStart = t;
        if ((t - r.lobbyStart) / 1000 >= PUBLIC_LOBBY) startMatch(r);
      }
      continue;
    }
    if (r.phase === 'goal') {
      if (el >= GOAL_PAUSE) { resetPositions(r); setPhase(r, 'kickoff'); io.to(r.code).emit('sfx', { t: 'whistle' }); }
      continue;
    }
    if (r.phase === 'ended') {
      if (el >= END_PAUSE) {
        for (var id in r.players) if (r.players[id].isBot) delete r.players[id];
        r.lobbyStart = 0; setPhase(r, 'lobby');
      }
      continue;
    }
    // kickoff | playing
    step(r);
    if (r.phase !== 'kickoff' && r.phase !== 'playing') continue;
    if (r.golden) {
      r.goldenLeft -= 1 / TPS;
      if (r.goldenLeft <= 0) { say(r, 'Nadie la metió en el gol de oro… ¡empate!', true); endMatch(r); }
    } else {
      r.timeLeft -= 1 / TPS;
      if (r.timeLeft <= 60 && !r.lastMinuteSaid) { r.lastMinuteSaid = true; say(r, '¡Último minuto! ¡Se viene el final!', true); }
      if (r.timeLeft <= 0) {
        r.timeLeft = 0;
        if (r.score.red === r.score.blue) { r.golden = true; r.goldenLeft = GOLDEN_MAX; say(r, '¡Empate! Se juega con GOL DE ORO: el que la mete gana', true); io.to(r.code).emit('sfx', { t: 'whistle' }); }
        else endMatch(r);
      }
    }
  }
}, 1000 / TPS);

// ── Network ──
function r1(v) { return Math.round(v * 10) / 10; }
setInterval(function() {
  var t = now();
  for (var code in rooms) {
    var r = rooms[code];
    var ps = [];
    for (var id in r.players) {
      var p = r.players[id];
      ps.push({ i: p.id, n: p.name, t: p.team, b: p.isBot ? 1 : 0, x: r1(p.x), y: r1(p.y),
        c: p.charge ? Math.round(p.charge / CHARGE_TICKS * 100) / 100 : 0, k: p.kickHeld ? 1 : 0,
        q: p.quickUntil > t ? p.quick : null, r: p.role });
    }
    var st = { ph: r.phase, code: r.code, pub: r.isPublic ? 1 : 0, host: r.host, ts: r.teamSize, du: r.duration,
      W: r.W, H: r.H, G: r.G, gd: GOAL_DEPTH, sc: r.score, tl: Math.ceil(r.timeLeft), gold: r.golden ? 1 : 0,
      ko: r.phase === 'kickoff' ? r.kickoffTeam : null, p: ps, now: t };
    if (r.ball) st.bl = [r1(r.ball.x), r1(r.ball.y)];
    if (r.phase === 'lobby' && r.isPublic) st.lt = r.lobbyStart ? Math.max(0, Math.ceil(PUBLIC_LOBBY - (t - r.lobbyStart) / 1000)) : PUBLIC_LOBBY;
    io.volatile.to(code).emit('s', st);
  }
}, 1000 / NET_TPS);

// ── Sockets ──
io.on('connection', function(socket) {
  var room = null;

  function leave() {
    if (!room) return;
    var r = room, p = r.players[socket.id];
    socket.leave(r.code);
    room = null;
    if (!p) return;
    delete r.players[socket.id];
    if (r.phase !== 'lobby' && (p.team === 'red' || p.team === 'blue')) {
      // A bot takes over so the match keeps going
      var b = newPlayer('bot_' + r.code + '_' + (++r.botCounter), 'Bot ' + p.name.substring(0, 7), true, p.team);
      ['x', 'y', 'vx', 'vy', 'role', 'stats'].forEach(function(k) { b[k] = p[k]; });
      r.players[b.id] = b;
      r.touches.forEach(function(t) { if (t.id === p.id) t.id = b.id; });
    }
    var hs = humans(r);
    if (r.host === socket.id) r.host = hs.length ? hs[0].id : null;
    if (!hs.length) { delete rooms[r.code]; return; }
    io.to(r.code).emit('msg', { t: p.name + ' se fue' });
  }

  socket.on('join', function(d) {
    d = d || {};
    leave();
    var code = String(d.code || '').toUpperCase().replace(/[^A-Z]/g, '').substring(0, 7);
    var r;
    if (d.create) r = createRoom(newCode(), false);
    else if (!code || code === PUBLIC_CODE) r = rooms[PUBLIC_CODE] || createRoom(PUBLIC_CODE, true);
    else {
      r = rooms[code];
      if (!r) { socket.emit('err', { t: 'No existe la sala ' + code + '. Revisá el código o creá una nueva.' }); return; }
    }
    room = r;
    socket.join(r.code);
    var p = newPlayer(socket.id, clean(d.name), false, 'spec');
    if (r.phase === 'lobby') p.team = balanceTeam(r);
    else {
      // Mid-match: take a bot's place, preferring the team with fewer humans
      var pref = balanceTeam(r), other = pref === 'red' ? 'blue' : 'red';
      var bot = teamList(r, pref).filter(function(q) { return q.isBot; })[0] || teamList(r, other).filter(function(q) { return q.isBot; })[0];
      if (bot) {
        p.team = bot.team; ['x', 'y', 'vx', 'vy', 'role'].forEach(function(k) { p[k] = bot[k]; });
        delete r.players[bot.id];
        r.touches.forEach(function(t) { if (t.id === bot.id) t.id = p.id; });
        io.to(r.code).emit('msg', { t: p.name + ' entró por ' + bot.name });
      }
    }
    r.players[socket.id] = p;
    if (!r.host || !r.players[r.host]) r.host = socket.id;
    if (r.phase !== 'lobby') assignRoles(r);
    socket.emit('joined', { id: socket.id, code: r.code, pub: r.isPublic, quick: QUICK });
    socket.emit('phase', { phase: r.phase });
  });

  socket.on('team', function(team) {
    var r = room, p = r && r.players[socket.id];
    if (!p || r.phase !== 'lobby' || ['red', 'blue', 'spec'].indexOf(team) === -1) return;
    if (team !== 'spec' && teamList(r, team).filter(function(q) { return !q.isBot; }).length >= 4) return;
    p.team = team;
  });

  socket.on('settings', function(d) {
    var r = room;
    if (!r || r.host !== socket.id || r.phase !== 'lobby' || !d) return;
    if (SIZES[d.ts]) { r.teamSize = d.ts; setPitch(r); }
    if ([120, 180, 300].indexOf(d.du) !== -1) r.duration = d.du;
  });

  socket.on('start', function() {
    var r = room;
    if (!r || r.phase !== 'lobby') return;
    if (!r.isPublic && r.host !== socket.id) return;
    // Enough room for every human on the pitch
    var red = teamList(r, 'red').filter(function(q) { return !q.isBot; }).length, blue = teamList(r, 'blue').filter(function(q) { return !q.isBot; }).length;
    var need = Math.max(red, blue, 1);
    if (need > r.teamSize) { r.teamSize = Math.min(4, need); setPitch(r); }
    startMatch(r);
  });

  socket.on('input', function(d) {
    var p = room && room.players[socket.id];
    if (!p || !d) return;
    var x = +d.x, y = +d.y;
    p.ix = isFinite(x) ? clamp(x, -1, 1) : 0; p.iy = isFinite(y) ? clamp(y, -1, 1) : 0;
    var held = !!d.k;
    if (p.kickHeld && !held) p.kickRelease = true;
    if (held && !p.kickHeld) p.charge = 0;
    p.kickHeld = held;
  });

  socket.on('quick', function(i) {
    var r = room, p = r && r.players[socket.id], t = now();
    if (!p || !QUICK[i] || t - p.lastQuick < 1200) return;
    p.lastQuick = t; p.quick = QUICK[i]; p.quickUntil = t + 2500;
    io.to(r.code).emit('chat', { n: p.name, t: p.team, m: QUICK[i] });
  });

  socket.on('disconnect', leave);
});

};
