var WORLD = require('./world-data');
var SCENARIOS = require('./world-scenarios');

// Optional Claude API integration
var Anthropic = null;
var anthropic = null;
try {
  Anthropic = require('@anthropic-ai/sdk');
  if (process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('[world] Claude API enabled');
  } else {
    console.log('[world] No ANTHROPIC_API_KEY, using rule-based AI');
  }
} catch (e) {
  console.log('[world] @anthropic-ai/sdk not installed, using rule-based AI');
}

module.exports = function(io) {

var MAX_TURNS = 15;
var MAX_PLAYERS = 4;

var state = resetState();

function resetState() {
  return {
    phase: 'lobby',
    scenario: '1936',
    difficulty: 'normal',
    players: {},
    countries: {},
    turn: 0,
    chat: [],
    log: [],
    winner: null,
    countryChats: {}, // { countryId: [{role, text}] }
  };
}

var PLAYER_COLORS = ['#EF4444', '#3B82F6', '#22C55E', '#F59E0B'];

function initCountries(scenarioId) {
  var sc = SCENARIOS.scenarios[scenarioId];
  var defaults = SCENARIOS.defaultStats(scenarioId);
  var aliases = scenarioId === '1936' ? (WORLD.aliases1936 || {}) : {};
  var countries = {};

  // First, mark countries that are "controlled by" a major power in this scenario
  var controlled = {}; // territoryId -> controllerId
  for (var ctrl in aliases) {
    (aliases[ctrl].controls || []).forEach(function(t) { controlled[t] = ctrl; });
  }

  WORLD.countries.forEach(function(c) {
    var stats = sc.stats[c.id] || defaults;
    var alias = aliases[c.id];
    countries[c.id] = {
      id: c.id,
      displayName: alias ? alias.name : c.name,
      army: stats.army,
      eco: stats.eco,
      tech: stats.tech,
      pers: stats.pers,
      allies: stats.allies.slice(),
      war: stats.war.slice(),
      owner: null,
      controlledBy: controlled[c.id] || null, // for 1936 colonies
      territories: [c.id],
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
    aliases: state.scenario === '1936' ? WORLD.aliases1936 : {},
    scenarios: Object.keys(SCENARIOS.scenarios).map(function(k) {
      return { id: k, name: SCENARIOS.scenarios[k].name, desc: SCENARIOS.scenarios[k].desc };
    })
  });
}

function broadcastGameState() {
  var snap = {
    turn: state.turn,
    maxTurns: MAX_TURNS,
    scenario: state.scenario,
    countries: {},
    players: {},
    aliases: state.scenario === '1936' ? WORLD.aliases1936 : {},
  };
  for (var cid in state.countries) {
    var c = state.countries[cid];
    snap.countries[cid] = {
      displayName: c.displayName,
      army: c.army, eco: c.eco, tech: c.tech,
      owner: c.owner,
      controlledBy: c.controlledBy,
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
  state.log = [];
  state.countryChats = {};
  for (var sid in state.players) {
    var p = state.players[sid];
    if (p.country && state.countries[p.country]) {
      state.countries[p.country].owner = sid;
    }
  }
  io.emit('gameStart', { scenario: state.scenario });
  addLog('Inicia partida: ' + SCENARIOS.scenarios[state.scenario].name);
  broadcastGameState();
}

function nextTurn() {
  if (state.phase !== 'playing') return;

  // Run bots
  runBotsTurn();

  // Resolve combats
  resolveCombats();

  // Economy growth
  for (var cid in state.countries) {
    var c = state.countries[cid];
    c.eco += Math.floor(c.eco * 0.05);
  }

  state.turn++;
  if (state.turn > MAX_TURNS) {
    endGame();
    return;
  }
  broadcastGameState();
  io.emit('turnEnd', { turn: state.turn - 1 });
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
      addLog(p.name + ' (' + mine.displayName + ') construyo ' + action.amount + ' tropas');
    }
  } else if (action.type === 'declareWar' && action.target) {
    var t = state.countries[action.target];
    if (t && action.target !== p.country) {
      if (mine.war.indexOf(action.target) === -1) mine.war.push(action.target);
      if (t.war.indexOf(p.country) === -1) t.war.push(p.country);
      mine.allies = mine.allies.filter(function(x) { return x !== action.target; });
      t.allies = t.allies.filter(function(x) { return x !== p.country; });
      addLog(mine.displayName + ' declaro guerra a ' + t.displayName);
    }
  } else if (action.type === 'alliance' && action.target) {
    var t2 = state.countries[action.target];
    if (t2 && action.target !== p.country) {
      if (mine.war.indexOf(action.target) === -1) {
        if (mine.allies.indexOf(action.target) === -1) mine.allies.push(action.target);
        if (t2.allies.indexOf(p.country) === -1) t2.allies.push(p.country);
        addLog(mine.displayName + ' y ' + t2.displayName + ' formaron alianza');
      }
    }
  } else if (action.type === 'invade' && action.target) {
    if (!mine._invasions) mine._invasions = [];
    mine._invasions.push(action.target);
  } else if (action.type === 'trade' && action.target && action.amount > 0) {
    var t3 = state.countries[action.target];
    if (t3 && mine.eco >= action.amount) {
      mine.eco -= action.amount;
      t3.eco += action.amount;
      addLog(mine.displayName + ' envio ' + action.amount + ' oro a ' + t3.displayName);
    }
  }
  broadcastGameState();
}

function resolveCombats() {
  for (var cid in state.countries) {
    var attacker = state.countries[cid];
    if (!attacker._invasions) continue;
    attacker._invasions.forEach(function(targetId) {
      var defender = state.countries[targetId];
      if (!defender) return;
      var neighbors = WORLD.neighbors[cid] || [];
      if (neighbors.indexOf(targetId) === -1) return;
      if (attacker.war.indexOf(targetId) === -1) return;
      var aPower = attacker.army + attacker.tech * 10;
      var dPower = defender.army + defender.tech * 15;
      defender.allies.forEach(function(ally) {
        var a = state.countries[ally];
        if (a) dPower += Math.floor(a.army * 0.1);
      });
      var roll = Math.random() * 0.4 + 0.8;
      aPower *= roll;
      if (aPower > dPower) {
        var lost = Math.floor(attacker.army * 0.2);
        attacker.army -= lost;
        defender.army = Math.floor(defender.army * 0.5);
        if (defender.territories.length > 1) {
          var taken = defender.territories.pop();
          attacker.territories.push(taken);
        }
        addLog(attacker.displayName + ' INVADIO ' + defender.displayName + ' (perdio ' + lost + ' tropas)');
      } else {
        attacker.army = Math.floor(attacker.army * 0.6);
        defender.army -= Math.floor(defender.army * 0.15);
        addLog(attacker.displayName + ' fue REPELIDO al invadir ' + defender.displayName);
      }
    });
    delete attacker._invasions;
  }
}

function runBotsTurn() {
  var diffMod = state.difficulty === 'hard' ? 1.5 : (state.difficulty === 'easy' ? 0.5 : 1);
  for (var cid in state.countries) {
    var c = state.countries[cid];
    if (c.owner) continue;
    if (c.eco > 50 && c.pers !== 'isolationist') {
      var spend = Math.floor(c.eco * 0.3 * diffMod);
      var add = Math.floor(spend / 2);
      c.eco -= spend;
      c.army += add;
    }
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
          addLog(c.displayName + ' (BOT) declaro guerra a ' + state.countries[weakest].displayName);
        }
        if (!c._invasions) c._invasions = [];
        c._invasions.push(weakest);
      }
    }
  }
}

// ── Country chat with AI ──
function getCountryChat(sid, countryId, userMsg, callback) {
  var country = state.countries[countryId];
  if (!country) return callback({ text: 'Pais no encontrado' });
  var p = state.players[sid];
  if (!p || !p.country) return callback({ text: 'No estas en juego' });
  var mine = state.countries[p.country];

  // Initialize chat history per country
  if (!state.countryChats[countryId]) state.countryChats[countryId] = [];
  state.countryChats[countryId].push({ role: 'user', from: p.name, text: userMsg });

  var relationStatus = 'neutrales';
  if (mine.allies.indexOf(countryId) !== -1) relationStatus = 'aliados';
  if (mine.war.indexOf(countryId) !== -1) relationStatus = 'en guerra';

  // If Claude API is available, use it
  if (anthropic) {
    var sysPrompt = 'Sos el lider de ' + country.displayName + ' (personalidad: ' + country.pers + ') en el escenario ' + (state.scenario === '1936' ? '1936 (vísperas WWII)' : '2026 (tensión moderna)') + '. Hablas con ' + mine.displayName + '. Estamos ' + relationStatus + '. Tu pais tiene ejercito ' + country.army + ', economia ' + country.eco + '. Responde SIEMPRE en español, breve (1-2 frases), en tono diplomatico realista segun tu personalidad. NO uses markdown ni emojis.';
    anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: sysPrompt,
      messages: [{ role: 'user', content: userMsg }]
    }).then(function(resp) {
      var text = resp.content[0].text || '...';
      state.countryChats[countryId].push({ role: 'ai', text: text });
      callback({ text: text, from: country.displayName });
    }).catch(function(err) {
      console.error('Claude error:', err.message);
      callback({ text: ruleBasedReply(country, mine, userMsg, relationStatus), from: country.displayName });
    });
  } else {
    callback({ text: ruleBasedReply(country, mine, userMsg, relationStatus), from: country.displayName });
  }
}

function ruleBasedReply(country, mine, msg, status) {
  var lower = msg.toLowerCase();
  var pers = country.pers;
  if (lower.indexOf('alianza') !== -1 || lower.indexOf('aliad') !== -1) {
    if (pers === 'diplomatic') return 'Una alianza con ' + mine.displayName + ' seria beneficiosa para ambos. Acepto.';
    if (pers === 'aggressive') return 'No necesito tu alianza. Ten cuidado.';
    return 'Lo consideraremos cuidadosamente.';
  }
  if (lower.indexOf('paz') !== -1) {
    if (status === 'en guerra') return pers === 'aggressive' ? 'La paz solo si te rindes.' : 'Estamos abiertos a negociar la paz.';
    return 'Ya estamos en paz, ¿no?';
  }
  if (lower.indexOf('guerra') !== -1) {
    if (pers === 'aggressive') return 'No tememos a la guerra. Ven a nosotros.';
    return 'La guerra solo trae destruccion. Esperamos no llegar a eso.';
  }
  if (lower.indexOf('comercio') !== -1 || lower.indexOf('trato') !== -1) {
    if (pers === 'economic' || pers === 'diplomatic') return 'El comercio nos beneficia a todos. Hablemos.';
    return 'Podemos discutir un acuerdo comercial.';
  }
  // Default
  if (pers === 'aggressive') return 'No tengo tiempo para diplomacia.';
  if (pers === 'diplomatic') return 'Siempre es un placer hablar con ' + mine.displayName + '.';
  return 'Tomamos nota de tu mensaje.';
}

function endGame() {
  state.phase = 'ended';
  var scores = [];
  for (var cid in state.countries) {
    var c = state.countries[cid];
    var score = c.territories.length * 100 + c.army + c.eco / 2;
    scores.push({ country: cid, displayName: c.displayName, owner: c.owner, score: Math.round(score) });
  }
  scores.sort(function(a, b) { return b.score - a.score; });
  state.winner = scores[0];
  io.emit('gameEnd', { scores: scores.slice(0, 10), winner: state.winner });
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

io.on('connection', function(socket) {
  broadcastLobby();

  socket.on('join', function(data) {
    if (state.phase !== 'lobby') return socket.emit('error', { msg: 'Partida en curso' });
    if (Object.keys(state.players).length >= MAX_PLAYERS) return socket.emit('error', { msg: 'Sala llena' });
    var name = (data.name || 'Lider').substring(0, 14);
    var color = PLAYER_COLORS[Object.keys(state.players).length];
    state.players[socket.id] = { name: name, color: color, country: null };
    addChat('Sistema', '#888', name + ' se unio');
    broadcastLobby();
  });

  socket.on('selectCountry', function(data) {
    var p = state.players[socket.id];
    if (!p || state.phase !== 'lobby') return;
    for (var sid in state.players) {
      if (sid !== socket.id && state.players[sid].country === data.country) return socket.emit('error', { msg: 'Pais ya tomado' });
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
    if (!hasPlayer) return socket.emit('error', { msg: 'Elegi un pais primero' });
    startGame();
  });

  socket.on('action', function(data) {
    if (state.phase !== 'playing') return;
    applyAction(socket.id, data);
  });

  socket.on('nextTurn', function() {
    if (state.phase !== 'playing') return;
    nextTurn();
  });

  socket.on('countryChat', function(data) {
    var msg = (data.msg || '').substring(0, 300);
    if (!msg || !data.country) return;
    getCountryChat(socket.id, data.country, msg, function(reply) {
      socket.emit('countryReply', { country: data.country, text: reply.text, from: reply.from });
    });
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
      if (p.country && state.countries[p.country]) state.countries[p.country].owner = null;
      delete state.players[socket.id];
      broadcastLobby();
    }
  });
});

};
