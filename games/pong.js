module.exports = function(io) {

// ── Config ──
var TPS = 60;
var NET_TPS = 30;
var ARENA = 800; // square arena
var PAD_LEN = 120;
var PAD_THICK = 12;
var PAD_SPEED = 6;
var BALL_R = 10;
var BALL_SPEED_INIT = 4;
var BALL_SPEED_MAX = 9;
var BALL_ACCEL = 0.15; // speed up each hit
var SCORE_TO_WIN = 5;
var LOBBY_TIME = 15; // seconds to wait for players
var POWERUP_INTERVAL = 8000; // ms between powerup spawns
var POWERUP_DURATION = 5000;

// ── Bot config ──
var BOT_SPEED = PAD_SPEED * 0.8; // 80% of normal pad speed
var BOT_DEADZONE = 20; // only move if ball is more than 20px off from pad center
var botIdCounter = 0;

// ── Sides: top, right, bottom, left ──
var SIDES = ['top', 'right', 'bottom', 'left'];
var SIDE_COLORS = ['#EF4444', '#3B82F6', '#22C55E', '#F59E0B'];

// ── Game state ──
var phase = 'waiting'; // waiting | playing | ended
var phaseStart = 0;
var players = {}; // socketId -> { side, name, color, pos, score, alive, effects, isBot }
var sideMap = {}; // side -> socketId
var ball = null;
var balls = []; // multi-ball powerup
var powerups = [];
var lastPowerup = 0;

var POWERUP_TYPES = [
  { type: 'big', icon: '📏', color: '#A78BFA', desc: 'Paleta grande' },
  { type: 'small', icon: '🔻', color: '#EF4444', desc: 'Enemigos chicos' },
  { type: 'fast', icon: '⚡', color: '#FBBF24', desc: 'Pelota rapida' },
  { type: 'multi', icon: '🔮', color: '#EC4899', desc: 'Multi pelota' },
];

function resetBall() {
  var angle = Math.random() * Math.PI * 2;
  // Avoid too-horizontal or too-vertical angles
  while (Math.abs(Math.cos(angle)) < 0.3 || Math.abs(Math.sin(angle)) < 0.3) {
    angle = Math.random() * Math.PI * 2;
  }
  return {
    x: ARENA / 2, y: ARENA / 2,
    vx: Math.cos(angle) * BALL_SPEED_INIT,
    vy: Math.sin(angle) * BALL_SPEED_INIT,
    speed: BALL_SPEED_INIT,
    r: BALL_R,
  };
}

function spawnPowerup() {
  var t = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  return {
    x: 150 + Math.random() * (ARENA - 300),
    y: 150 + Math.random() * (ARENA - 300),
    r: 14, type: t.type, icon: t.icon, color: t.color,
  };
}

function getPadRect(side, pos, padLen) {
  var half = padLen / 2;
  if (side === 'top') return { x: pos - half, y: 0, w: padLen, h: PAD_THICK };
  if (side === 'bottom') return { x: pos - half, y: ARENA - PAD_THICK, w: padLen, h: PAD_THICK };
  if (side === 'left') return { x: 0, y: pos - half, w: PAD_THICK, h: padLen };
  if (side === 'right') return { x: ARENA - PAD_THICK, y: pos - half, w: PAD_THICK, h: padLen };
}

function getPlayerPadLen(p) {
  if (p.effects && p.effects.big && p.effects.big > Date.now()) return PAD_LEN * 1.6;
  if (p.effects && p.effects.small && p.effects.small > Date.now()) return PAD_LEN * 0.6;
  return PAD_LEN;
}

// ── Bot management ──
function createBot(botNum) {
  var botId = 'bot_' + (++botIdCounter);
  players[botId] = {
    side: null,
    name: 'Bot ' + botNum,
    color: '#fff',
    pos: ARENA / 2,
    score: 0,
    alive: true,
    input: 0,
    effects: {},
    isBot: true,
  };
  return botId;
}

function removeBots() {
  var ids = Object.keys(players);
  for (var i = 0; i < ids.length; i++) {
    if (players[ids[i]] && players[ids[i]].isBot) {
      var side = players[ids[i]].side;
      if (side && sideMap[side] === ids[i]) {
        delete sideMap[side];
      }
      delete players[ids[i]];
    }
  }
}

function fillBotsForGame() {
  // Count how many sides are already taken by human players
  var takenSides = [];
  for (var i = 0; i < SIDES.length; i++) {
    var sid = sideMap[SIDES[i]];
    if (sid && players[sid] && !players[sid].isBot) {
      takenSides.push(SIDES[i]);
    }
  }
  // Fill remaining sides with bots
  var botNum = 1;
  for (var j = 0; j < SIDES.length; j++) {
    var side = SIDES[j];
    var owner = sideMap[side];
    if (!owner || !players[owner]) {
      var botId = createBot(botNum++);
      players[botId].side = side;
      players[botId].color = SIDE_COLORS[j];
      players[botId].pos = ARENA / 2;
      sideMap[side] = botId;
    } else if (players[owner].isBot) {
      // Already a bot here, skip but increment counter
      botNum++;
    }
  }
}

function updateBotAI() {
  // Collect all active balls
  var allBalls = [];
  if (ball) allBalls.push(ball);
  for (var bi = 0; bi < balls.length; bi++) allBalls.push(balls[bi]);
  if (!allBalls.length) return;

  for (var id in players) {
    var p = players[id];
    if (!p.isBot || !p.alive || !p.side) continue;

    // Find closest ball heading toward this bot's side
    var isHoriz = (p.side === 'top' || p.side === 'bottom');
    var bestDist = Infinity, targetPos = isHoriz ? ball.x : ball.y;
    for (var i = 0; i < allBalls.length; i++) {
      var ab = allBalls[i];
      // Check if ball is heading toward this side
      var heading = false;
      if (p.side === 'top' && ab.vy < 0) heading = true;
      if (p.side === 'bottom' && ab.vy > 0) heading = true;
      if (p.side === 'left' && ab.vx < 0) heading = true;
      if (p.side === 'right' && ab.vx > 0) heading = true;
      var dist = isHoriz ? Math.abs(ab.y - (p.side === 'top' ? 0 : ARENA)) : Math.abs(ab.x - (p.side === 'left' ? 0 : ARENA));
      if (heading && dist < bestDist) { bestDist = dist; targetPos = isHoriz ? ab.x : ab.y; }
    }

    var diff = targetPos - p.pos;
    var padLen = getPlayerPadLen(p);
    var half = padLen / 2;
    if (Math.abs(diff) > 10) {
      if (diff < 0) p.pos = Math.max(half, p.pos - BOT_SPEED);
      else p.pos = Math.min(ARENA - half, p.pos + BOT_SPEED);
    }
  }
}

function startGame() {
  // Fill empty sides with bots before starting
  fillBotsForGame();

  phase = 'playing';
  phaseStart = Date.now();
  ball = resetBall();
  balls = [];
  powerups = [];
  lastPowerup = Date.now();
  for (var id in players) {
    players[id].score = 0;
    players[id].alive = true;
    players[id].pos = ARENA / 2;
    players[id].effects = {};
  }
  io.emit('phase', { phase: 'playing' });
}

function endGame(winnerId) {
  phase = 'ended';
  var w = players[winnerId];
  io.emit('phase', { phase: 'ended', winner: w ? w.name : '??', color: w ? w.color : '#fff' });
  setTimeout(function() {
    // Reset to waiting - remove all bots
    removeBots();
    phase = 'waiting';
    phaseStart = Date.now();
    sideMap = {};
    for (var id in players) {
      players[id].score = 0;
      players[id].alive = true;
      players[id].side = null;
    }
    assignSides();
    io.emit('phase', { phase: 'waiting', time: LOBBY_TIME });
  }, 5000);
}

function assignSides() {
  // Only assign human players during waiting phase
  var ids = Object.keys(players).filter(function(id) { return !players[id].isBot; });
  sideMap = {};
  for (var i = 0; i < ids.length && i < 4; i++) {
    players[ids[i]].side = SIDES[i];
    players[ids[i]].color = SIDE_COLORS[i];
    players[ids[i]].pos = ARENA / 2;
    sideMap[SIDES[i]] = ids[i];
  }
}

function getAliveCount() {
  var c = 0;
  for (var id in players) { if (players[id].alive && players[id].side) c++; }
  return c;
}

// ── Ball vs pad collision ──
function checkPadCollision(b) {
  for (var id in players) {
    var p = players[id];
    if (!p.alive || !p.side) continue;
    var padLen = getPlayerPadLen(p);
    var r = getPadRect(p.side, p.pos, padLen);

    // Simple AABB
    if (b.x + b.r > r.x && b.x - b.r < r.x + r.w && b.y + b.r > r.y && b.y - b.r < r.y + r.h) {
      // Bounce
      if (p.side === 'top' || p.side === 'bottom') {
        b.vy = -b.vy;
        b.y = p.side === 'top' ? r.y + r.h + b.r : r.y - b.r;
        // Add angle based on where it hit the pad
        var hitPos = (b.x - r.x) / padLen - 0.5; // -0.5 to 0.5
        b.vx += hitPos * 2;
      } else {
        b.vx = -b.vx;
        b.x = p.side === 'left' ? r.x + r.w + b.r : r.x - b.r;
        var hitPos2 = (b.y - r.y) / padLen - 0.5;
        b.vy += hitPos2 * 2;
      }
      // Speed up
      b.speed = Math.min(BALL_SPEED_MAX, b.speed + BALL_ACCEL);
      var mag = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      b.vx = (b.vx / mag) * b.speed;
      b.vy = (b.vy / mag) * b.speed;

      io.emit('hit', { side: p.side });
      return true;
    }
  }
  return false;
}

// ── Check if ball went past a wall (goal) ──
function checkGoal(b) {
  var scored = null;
  if (b.y - b.r <= 0) scored = 'top';
  else if (b.y + b.r >= ARENA) scored = 'bottom';
  else if (b.x - b.r <= 0) scored = 'left';
  else if (b.x + b.r >= ARENA) scored = 'right';

  if (!scored) return false;

  var ownerId = sideMap[scored];
  if (ownerId && players[ownerId] && players[ownerId].alive) {
    players[ownerId].score++;
    if (players[ownerId].score >= SCORE_TO_WIN) {
      players[ownerId].alive = false;
      // Check if only one left
      var alive = [];
      for (var id in players) { if (players[id].alive && players[id].side) alive.push(id); }
      if (alive.length <= 1) {
        endGame(alive[0] || ownerId);
      }
    }
    io.emit('goal', { side: scored, scores: getScores() });
  }
  return true;
}

function getScores() {
  var s = {};
  for (var id in players) {
    if (players[id].side) s[players[id].side] = { name: players[id].name, score: players[id].score, alive: players[id].alive, color: players[id].color };
  }
  return s;
}

// ── Physics ──
setInterval(function() {
  if (phase === 'waiting') {
    var elapsed = (Date.now() - phaseStart) / 1000;
    // Allow game to start with at least 1 human player (bots fill the rest)
    var humanCount = Object.keys(players).filter(function(id) { return players[id].side && !players[id].isBot; }).length;
    if (humanCount >= 1 && elapsed >= LOBBY_TIME) {
      startGame();
    }
    return;
  }
  if (phase !== 'playing') return;

  // Bot AI - update bot paddle targets before moving pads
  updateBotAI();

  // Move pads
  for (var id in players) {
    var p = players[id];
    if (!p.alive || !p.side) continue;
    // Skip bots here - their movement is handled by updateBotAI
    if (p.isBot) continue;
    var padLen = getPlayerPadLen(p);
    var half = padLen / 2;
    if (p.input === -1) p.pos = Math.max(half, p.pos - PAD_SPEED);
    if (p.input === 1) p.pos = Math.min(ARENA - half, p.pos + PAD_SPEED);
  }

  // Move ball
  if (ball) {
    ball.x += ball.vx;
    ball.y += ball.vy;

    // Bounce off walls where no player is assigned (or player is dead)
    // Top wall
    if (ball.y - ball.r <= 0) {
      var topOwner = sideMap['top'];
      if (!topOwner || !players[topOwner] || !players[topOwner].alive) {
        ball.vy = Math.abs(ball.vy);
        ball.y = ball.r;
      }
    }
    if (ball.y + ball.r >= ARENA) {
      var botOwner = sideMap['bottom'];
      if (!botOwner || !players[botOwner] || !players[botOwner].alive) {
        ball.vy = -Math.abs(ball.vy);
        ball.y = ARENA - ball.r;
      }
    }
    if (ball.x - ball.r <= 0) {
      var leftOwner = sideMap['left'];
      if (!leftOwner || !players[leftOwner] || !players[leftOwner].alive) {
        ball.vx = Math.abs(ball.vx);
        ball.x = ball.r;
      }
    }
    if (ball.x + ball.r >= ARENA) {
      var rightOwner = sideMap['right'];
      if (!rightOwner || !players[rightOwner] || !players[rightOwner].alive) {
        ball.vx = -Math.abs(ball.vx);
        ball.x = ARENA - ball.r;
      }
    }

    checkPadCollision(ball);
    if (checkGoal(ball)) {
      ball = resetBall();
    }

    // Powerup collision
    for (var pi = powerups.length - 1; pi >= 0; pi--) {
      var pw = powerups[pi];
      var dx = ball.x - pw.x, dy = ball.y - pw.y;
      if (dx * dx + dy * dy < (ball.r + pw.r) * (ball.r + pw.r)) {
        // Find last player who hit the ball (closest pad)
        applyBallPowerup(pw.type);
        powerups.splice(pi, 1);
      }
    }
  }

  // Extra balls
  for (var bi = balls.length - 1; bi >= 0; bi--) {
    var eb = balls[bi];
    eb.x += eb.vx; eb.y += eb.vy;
    // Bounce off all walls
    if (eb.y - eb.r <= 0) { eb.vy = Math.abs(eb.vy); eb.y = eb.r; }
    if (eb.y + eb.r >= ARENA) { eb.vy = -Math.abs(eb.vy); eb.y = ARENA - eb.r; }
    if (eb.x - eb.r <= 0) { eb.vx = Math.abs(eb.vx); eb.x = eb.r; }
    if (eb.x + eb.r >= ARENA) { eb.vx = -Math.abs(eb.vx); eb.x = ARENA - eb.r; }
    checkPadCollision(eb);
    if (checkGoal(eb)) { balls.splice(bi, 1); }
    // Remove after 10 seconds
    if (Date.now() - eb.born > 10000) balls.splice(bi, 1);
  }

  // Spawn powerups
  if (Date.now() - lastPowerup > POWERUP_INTERVAL && powerups.length < 3) {
    powerups.push(spawnPowerup());
    lastPowerup = Date.now();
  }

}, 1000 / TPS);

function applyBallPowerup(type) {
  if (type === 'big') {
    // Random alive player gets big pad
    var alive = Object.keys(players).filter(function(id) { return players[id].alive && players[id].side; });
    if (alive.length) {
      var lucky = alive[Math.floor(Math.random() * alive.length)];
      players[lucky].effects.big = Date.now() + POWERUP_DURATION;
      io.emit('pwmsg', { msg: players[lucky].name + ' tiene paleta gigante!' });
    }
  } else if (type === 'small') {
    // All alive players get small
    for (var id in players) {
      if (players[id].alive && players[id].side) players[id].effects.small = Date.now() + POWERUP_DURATION;
    }
    io.emit('pwmsg', { msg: 'Paletas reducidas!' });
  } else if (type === 'fast') {
    if (ball) { ball.speed = Math.min(BALL_SPEED_MAX, ball.speed + 2); var m = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy); ball.vx = (ball.vx / m) * ball.speed; ball.vy = (ball.vy / m) * ball.speed; }
    io.emit('pwmsg', { msg: 'Pelota acelerada!' });
  } else if (type === 'multi') {
    for (var i = 0; i < 2; i++) {
      var nb = resetBall();
      nb.speed = ball ? ball.speed : BALL_SPEED_INIT;
      nb.born = Date.now();
      balls.push(nb);
    }
    io.emit('pwmsg', { msg: 'Multi pelota!' });
  }
}

// ── Network ──
setInterval(function() {
  var elapsed = Math.floor((Date.now() - phaseStart) / 1000);
  var tl = phase === 'waiting' ? Math.max(0, LOBBY_TIME - elapsed) : 0;
  var playerCount = Object.keys(players).filter(function(id) { return players[id].side; }).length;

  var state = {
    phase: phase,
    arena: ARENA,
    tl: tl,
    pc: playerCount,
    ball: ball,
    balls: balls,
    pw: powerups,
    scores: getScores(),
    pads: {},
  };

  for (var id in players) {
    var p = players[id];
    if (!p.side) continue;
    state.pads[p.side] = {
      pos: Math.round(p.pos),
      len: Math.round(getPlayerPadLen(p)),
      alive: p.alive,
      color: p.color,
      name: p.name,
    };
  }

  io.volatile.emit('s', state);
}, 1000 / NET_TPS);

// ── Sockets ──
io.on('connection', function(socket) {
  socket.on('join', function(data) {
    var name = (data.name || 'Jugador').substring(0, 12);
    players[socket.id] = { side: null, name: name, color: '#fff', pos: ARENA / 2, score: 0, alive: true, input: 0, effects: {}, isBot: false };
    assignSides();
    if (phase === 'waiting') phaseStart = Date.now();
    io.emit('phase', { phase: phase, time: LOBBY_TIME });
  });

  socket.on('input', function(data) {
    var p = players[socket.id];
    if (!p) return;
    p.input = data.dir || 0; // -1, 0, 1
  });

  socket.on('disconnect', function() {
    var p = players[socket.id];
    if (p && p.side) { delete sideMap[p.side]; }
    delete players[socket.id];
    // If in game and only 1 human left (or 0), end the game
    if (phase === 'playing') {
      var aliveHumans = Object.keys(players).filter(function(id) { return players[id].alive && players[id].side && !players[id].isBot; });
      var alive = Object.keys(players).filter(function(id) { return players[id].alive && players[id].side; });
      if (aliveHumans.length === 0) {
        // No humans left, end game
        endGame(alive[0]);
      } else if (alive.length <= 1) {
        endGame(alive[0]);
      }
    }
    assignSides();
  });
});

};
