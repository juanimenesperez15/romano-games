var WORLD = require('./world-data');
var SCENARIOS = require('./world-scenarios');

module.exports = function(io) {

var TURN_DURATION = 30000; // 30 sec per turn
var MAX_TURNS = 15;
var MAX_PLAYERS = 4;

// State
var state = resetState();

function resetState() {
  return {
    phase: 'lobby', // lobby, playing, ended
    scenario: '1936',
    difficulty: 'normal', // easy, normal, hard
    players: {}, // socketId -> { name, color, country, isReady }
    countries: {}, // countryId -> { army, eco, tech, pers, allies, war, owner (sid or null), territories: [countryId] }
    turn: 0,
    turnDeadline: 0,
    queuedActions: {}, // sid -> [{type, target, ...}]
    chat: [],
    log: [], // global event log
    winner: null,
  };
}

var PLAYER_COLORS = ['#EF4444', '#3B82F6', '#22C55E', '#F59E0B'];
var BOT_COLOR = '#888888';

function initCountries(scenarioId) {
  var sc = SCENARIOS.scenarios[scenarioId];
  var defaults = SCENARIOS.defaultStats(scenarioId);
  var countries = {};
  WORLD.countries.forEach(function(c) {
    var stats = sc.stats[c.id] || defaults;
    countries[c.id] = {
      id: c.id,
      army: stats.army,
      eco: stats.eco,
      tech: stats.tech,
      pers: stats.pers,
      allies: stats.allies.slice(),
      war: stats.war.slice(),
      owner: null, // null = bot, or socketId
      territories: [c.id], // controlled provinces (start with just self)
    };
  });
  return countries;
}

function broadcastLobby() {
  var players = [];
  for (var sid in state.players) {
    var p = state.players[sid];
    players.push({ name: p.name, color: p.color, country: p.country });
  }
  io.emit('lobby', {
    players: players,
    scenario: state.scenario,
    difficulty: state.difficulty,
    countries: WORLD.countries,
    scenarios: Object.keys(SCENARIOS.scenarios).map(function(k) {
      return { id: k, name: SCENARIOS.scenarios[k].name, desc: SCENARIOS.scenarios[k].desc };
    })
  });
}

function broadcastGameState() {
  // Send minimal state to all
  var snap = {
    turn: state.turn,
    maxTurns: MAX_TURNS,
    timeLeft: Math.max(0, Math.round((state.turnDeadline - Date.now()) / 1000)),
    countries: {},
    players: {},
  };
  for (var cid in state.countries) {
    var c = state.countries[cid];
    snap.countries[cid] = {
      army: c.army, eco: c.eco, tech: c.tech,
      owner: c.owner, // sid or null
      allies: c.allies, war: c.war,
      territories: c.territories,
    };
  }
  for (var sid in state.players) {
    var p = state.players[sid];
    snap.players[sid] = { name: p.name, color: p.color, country: p.country };
  }
  io.emit('state', snap);
}

function startGame() {
  if (state.phase !== 'lobby') return;
  state.phase = 'playing';
  state.countries = initCountries(state.scenario);
  state.turn = 1;
  state.turnDeadline = Date.now() + TURN_DURATION;
  state.queuedActions = {};
  state.log = [];
  // Assign owners
  for (var sid in state.players) {
    var p = state.players[sid];
    if (p.country && state.countries[p.country]) {
      state.countries[p.country].owner = sid;
    }
  }
  io.emit('gameStart', { scenario: state.scenario });
  addLog('Inicia partida: ' + SCENARIOS.scenarios[state.scenario].name);
  broadcastGameState();
  scheduleNextTurn();
}

var turnTimeout = null;
function scheduleNextTurn() {
  if (turnTimeout) clearTimeout(turnTimeout);
  turnTimeout = setTimeout(processTurn, TURN_DURATION);
}

function processTurn() {
  if (state.phase !== 'playing') return;

  // Apply queued actions
  for (var sid in state.queuedActions) {
    var actions = state.queuedActions[sid];
    actions.forEach(function(a) { applyAction(sid, a); });
  }
  state.queuedActions = {};

  // Bots act based on difficulty (rule-based for now, AI later)
  runBotsTurn();

  // Resolve combats
  resolveCombats();

  // Economy tick
  for (var cid in state.countries) {
    var c = state.countries[cid];
    c.eco += Math.floor(c.eco * 0.05); // 5% growth
  }

  state.turn++;
  if (state.turn > MAX_TURNS) {
    endGame();
    return;
  }
  state.turnDeadline = Date.now() + TURN_DURATION;
  broadcastGameState();
  io.emit('turnEnd', { turn: state.turn - 1 });
  scheduleNextTurn();
}

function applyAction(sid, action) {
  var p = state.players[sid];
  if (!p || !p.country) return;
  var mine = state.countries[p.country];
  if (!mine) return;

  if (action.type === 'build' && action.amount > 0) {
    var cost = action.amount * 2;
    if (mine.eco >= cost) {
      mine.eco -= cost;
      mine.army += action.amount;
      addLog(p.name + ' construyo ' + action.amount + ' tropas');
    }
  } else if (action.type === 'declareWar' && action.target) {
    var t = state.countries[action.target];
    if (t && action.target !== p.country) {
      if (mine.war.indexOf(action.target) === -1) mine.war.push(action.target);
      if (t.war.indexOf(p.country) === -1) t.war.push(p.country);
      // Break alliance
      mine.allies = mine.allies.filter(function(x) { return x !== action.target; });
      t.allies = t.allies.filter(function(x) { return x !== p.country; });
      addLog(p.name + ' (' + p.country + ') declaro guerra a ' + action.target);
    }
  } else if (action.type === 'alliance' && action.target) {
    var t2 = state.countries[action.target];
    if (t2 && action.target !== p.country) {
      // For now: auto-accept if not at war
      if (mine.war.indexOf(action.target) === -1) {
        if (mine.allies.indexOf(action.target) === -1) mine.allies.push(action.target);
        if (t2.allies.indexOf(p.country) === -1) t2.allies.push(p.country);
        addLog(p.country + ' y ' + action.target + ' formaron alianza');
      }
    }
  } else if (action.type === 'invade' && action.target) {
    // Queue invasion - resolved in resolveCombats
    if (!mine._invasions) mine._invasions = [];
    mine._invasions.push(action.target);
  }
}

function resolveCombats() {
  // Process all queued invasions
  for (var cid in state.countries) {
    var attacker = state.countries[cid];
    if (!attacker._invasions) continue;
    attacker._invasions.forEach(function(targetId) {
      var defender = state.countries[targetId];
      if (!defender) return;
      // Must be at war and adjacent
      var neighbors = WORLD.neighbors[cid] || [];
      if (neighbors.indexOf(targetId) === -1) return;
      if (attacker.war.indexOf(targetId) === -1) return;

      // Combat: attacker army+tech vs defender army+tech + random
      var aPower = attacker.army + attacker.tech * 10;
      var dPower = defender.army + defender.tech * 15; // defender bonus
      // Allies help
      defender.allies.forEach(function(ally) {
        var a = state.countries[ally];
        if (a) dPower += Math.floor(a.army * 0.1);
      });
      var roll = Math.random() * 0.4 + 0.8;
      aPower *= roll;

      if (aPower > dPower) {
        // Attacker wins, takes territory
        var lost = Math.floor(attacker.army * 0.2);
        attacker.army -= lost;
        defender.army = Math.floor(defender.army * 0.5);
        // Take one territory if defender has more than 1
        if (defender.territories.length > 1) {
          var taken = defender.territories.pop();
          attacker.territories.push(taken);
        }
        addLog(cid + ' INVADIO ' + targetId + ' (perdio ' + lost + ' tropas)');
      } else {
        attacker.army = Math.floor(attacker.army * 0.6);
        defender.army -= Math.floor(defender.army * 0.15);
        addLog(cid + ' fue REPELIDO al invadir ' + targetId);
      }
    });
    delete attacker._invasions;
  }
}

function runBotsTurn() {
  // Simple rule-based AI per personality
  var diffMod = state.difficulty === 'hard' ? 1.5 : (state.difficulty === 'easy' ? 0.5 : 1);
  for (var cid in state.countries) {
    var c = state.countries[cid];
    if (c.owner) continue; // skip players
    // Build army with available eco
    if (c.eco > 50 && c.pers !== 'isolationist') {
      var spend = Math.floor(c.eco * 0.3 * diffMod);
      var add = Math.floor(spend / 2);
      c.eco -= spend;
      c.army += add;
    }
    // Aggressive: try to attack a weaker neighbor
    if (c.pers === 'aggressive' && c.army > 100) {
      var neighbors = WORLD.neighbors[cid] || [];
      var weakest = null, weakestArmy = Infinity;
      neighbors.forEach(function(n) {
        var nc = state.countries[n];
        if (nc && nc.army < c.army * 0.7 && nc.army < weakestArmy) {
          weakest = n; weakestArmy = nc.army;
        }
      });
      if (weakest) {
        if (c.war.indexOf(weakest) === -1) {
          c.war.push(weakest);
          state.countries[weakest].war.push(cid);
          addLog(cid + ' (BOT) declaro guerra a ' + weakest);
        }
        if (!c._invasions) c._invasions = [];
        c._invasions.push(weakest);
      }
    }
  }
}

function endGame() {
  state.phase = 'ended';
  // Calculate winner by score
  var scores = [];
  for (var cid in state.countries) {
    var c = state.countries[cid];
    var score = c.territories.length * 100 + c.army + c.eco / 2;
    scores.push({ country: cid, owner: c.owner, score: Math.round(score) });
  }
  scores.sort(function(a, b) { return b.score - a.score; });
  state.winner = scores[0];
  io.emit('gameEnd', { scores: scores.slice(0, 10), winner: state.winner });
  if (turnTimeout) clearTimeout(turnTimeout);
  setTimeout(function() {
    state = resetState();
    broadcastLobby();
  }, 15000);
}

function addLog(msg) {
  state.log.push({ time: Date.now(), msg: msg, turn: state.turn });
  if (state.log.length > 50) state.log.shift();
  io.emit('log', { msg: msg, turn: state.turn });
}

function addChat(name, color, msg) {
  state.chat.push({ name: name, color: color, msg: msg });
  if (state.chat.length > 100) state.chat.shift();
  io.emit('chat', { name: name, color: color, msg: msg });
}

// Sockets
io.on('connection', function(socket) {
  broadcastLobby();

  socket.on('join', function(data) {
    if (state.phase !== 'lobby') {
      socket.emit('error', { msg: 'Partida en curso' });
      return;
    }
    if (Object.keys(state.players).length >= MAX_PLAYERS) {
      socket.emit('error', { msg: 'Sala llena' });
      return;
    }
    var name = (data.name || 'Lider').substring(0, 14);
    var color = PLAYER_COLORS[Object.keys(state.players).length];
    state.players[socket.id] = { name: name, color: color, country: null };
    addChat('Sistema', '#888', name + ' se unio');
    broadcastLobby();
  });

  socket.on('selectCountry', function(data) {
    var p = state.players[socket.id];
    if (!p || state.phase !== 'lobby') return;
    // Make sure no other player has this country
    for (var sid in state.players) {
      if (sid !== socket.id && state.players[sid].country === data.country) {
        socket.emit('error', { msg: 'Pais ya tomado' });
        return;
      }
    }
    p.country = data.country;
    broadcastLobby();
  });

  socket.on('setScenario', function(data) {
    if (state.phase !== 'lobby') return;
    if (SCENARIOS.scenarios[data.scenario]) {
      state.scenario = data.scenario;
      broadcastLobby();
    }
  });

  socket.on('setDifficulty', function(data) {
    if (state.phase !== 'lobby') return;
    if (['easy','normal','hard'].indexOf(data.difficulty) !== -1) {
      state.difficulty = data.difficulty;
      broadcastLobby();
    }
  });

  socket.on('start', function() {
    if (state.phase !== 'lobby') return;
    var hasPlayer = false;
    for (var sid in state.players) {
      if (state.players[sid].country) { hasPlayer = true; break; }
    }
    if (!hasPlayer) {
      socket.emit('error', { msg: 'Elegi un pais primero' });
      return;
    }
    startGame();
  });

  socket.on('action', function(data) {
    if (state.phase !== 'playing') return;
    if (!state.queuedActions[socket.id]) state.queuedActions[socket.id] = [];
    state.queuedActions[socket.id].push(data);
    socket.emit('actionQueued', { type: data.type });
  });

  socket.on('chat', function(data) {
    var p = state.players[socket.id];
    if (!p) return;
    var msg = (data.msg || '').substring(0, 200);
    if (!msg) return;
    addChat(p.name, p.color, msg);
  });

  socket.on('disconnect', function() {
    var p = state.players[socket.id];
    if (p) {
      addChat('Sistema', '#888', p.name + ' se desconecto');
      // Free their country
      if (p.country && state.countries[p.country]) {
        state.countries[p.country].owner = null;
      }
      delete state.players[socket.id];
      broadcastLobby();
    }
  });
});

};
