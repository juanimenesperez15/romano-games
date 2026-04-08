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

var MAX_PLAYERS = 4;
var GAME_DURATION_DAYS = 365 * 5; // Total game duration: 5 years
var TICK_INTERVAL_MS = 30000; // 30 sec gameplay window
var SUMMARY_PAUSE_MS = 10000; // 10 sec summary modal display
var DAYS_PER_TICK = 7;

var state = resetState();

function resetState() {
  return {
    phase: 'lobby',
    scenario: '1936',
    difficulty: 'normal',
    players: {},
    countries: {},
    daysElapsed: 0,
    nextTickAt: 0,
    tickCount: 0,
    recentEvents: [],
    queuedActions: {}, // sid -> [orders queued during this week]
    chat: [],
    log: [],
    winner: null,
    countryChats: {},
  };
}

function getStartDate(scenario) {
  return scenario === '1936' ? new Date(1936, 0, 1) : new Date(2026, 0, 1);
}
function getCurrentDate() {
  var d = getStartDate(state.scenario);
  d.setDate(d.getDate() + state.daysElapsed);
  return d;
}
function fmtDate(d) {
  return d.getDate() + '/' + (d.getMonth()+1) + '/' + d.getFullYear();
}

var PLAYER_COLORS = ['#EF4444', '#3B82F6', '#22C55E', '#F59E0B'];

function initCountries(scenarioId) {
  var sc = SCENARIOS.scenarios[scenarioId];
  var defaults = SCENARIOS.defaultStats(scenarioId);
  var aliases = scenarioId === '1936' ? (WORLD.aliases1936 || {}) : {};
  var countries = {};

  var controlled = {};
  for (var ctrl in aliases) {
    (aliases[ctrl].controls || []).forEach(function(t) { controlled[t] = ctrl; });
  }

  WORLD.countries.forEach(function(c) {
    var stats = sc.stats[c.id] || defaults;
    var alias = aliases[c.id];
    countries[c.id] = {
      id: c.id,
      displayName: alias ? alias.name : c.name,
      // Core resources
      army: stats.army,           // ground troops
      navy: Math.floor(stats.army * 0.3), // ships
      eco: stats.eco,             // gold treasury
      ecoIncome: Math.floor(stats.eco * 0.1) + 10, // per turn income
      tech: stats.tech,           // technology level (1-10)
      // Infrastructure
      industry: Math.floor(stats.eco / 30) + 1, // factories
      defense: Math.floor(stats.army * 0.2),    // border fortifications
      morale: 70,                 // population morale (0-100)
      // Strategic
      pers: stats.pers,
      allies: stats.allies.slice(),
      war: stats.war.slice(),
      owner: null,
      controlledBy: controlled[c.id] || null,
      territories: [c.id],
      events: [], // recent events affecting this country
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
    featured: (WORLD.featured && WORLD.featured[state.scenario]) || [],
    scenarios: Object.keys(SCENARIOS.scenarios).map(function(k) {
      return { id: k, name: SCENARIOS.scenarios[k].name, desc: SCENARIOS.scenarios[k].desc };
    })
  });
}

function broadcastGameState() {
  var basePlayers = {};
  for (var sid in state.players) {
    var p = state.players[sid];
    basePlayers[sid] = { name: p.name, color: p.color, country: p.country };
  }

  // Send personalized state per player (own stats full, others hidden)
  var dateStr = fmtDate(getCurrentDate());
  for (var psid in state.players) {
    var myPlayer = state.players[psid];
    var snap = {
      daysElapsed: state.daysElapsed,
      maxDays: GAME_DURATION_DAYS,
      currentDate: dateStr,
      nextTickAt: state.nextTickAt,
      tickInterval: TICK_INTERVAL_MS,
      scenario: state.scenario,
      countries: {},
      players: basePlayers,
      aliases: state.scenario === '1936' ? WORLD.aliases1936 : {},
      myCountry: myPlayer.country,
    };
    for (var cid in state.countries) {
      var c = state.countries[cid];
      var isMine = (c.owner === psid);
      snap.countries[cid] = {
        displayName: c.displayName,
        owner: c.owner,
        controlledBy: c.controlledBy,
        allies: c.allies,
        war: c.war,
        territories: c.territories,
      };
      if (isMine) {
        // Full info for owned country
        snap.countries[cid].army = c.army;
        snap.countries[cid].navy = c.navy;
        snap.countries[cid].eco = c.eco;
        snap.countries[cid].ecoIncome = c.ecoIncome;
        snap.countries[cid].tech = c.tech;
        snap.countries[cid].industry = c.industry;
        snap.countries[cid].defense = c.defense;
        snap.countries[cid].morale = c.morale;
        snap.countries[cid].pers = c.pers;
      } else {
        // Hidden - only relative strength approximations
        snap.countries[cid].armyApprox = approxStat(c.army);
        snap.countries[cid].techApprox = c.tech;
      }
    }
    io.to(psid).emit('state', snap);
  }
}

function approxStat(val) {
  if (val < 50) return 'muy debil';
  if (val < 150) return 'debil';
  if (val < 300) return 'moderado';
  if (val < 500) return 'fuerte';
  return 'muy fuerte';
}

function startGame() {
  if (state.phase !== 'lobby') return;
  state.phase = 'playing';
  state.countries = initCountries(state.scenario);
  state.daysElapsed = 0;
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
  startTicking();
}

function tickWeek() {
  if (state.phase !== 'playing') return;
  var fraction = DAYS_PER_TICK / 365;

  // 1. Process queued player actions
  var queuedSummary = []; // for AI global summary
  var sids = Object.keys(state.queuedActions);
  var pendingProcessing = sids.length;

  function finishTick() {
    runBotsTurn();
    resolveCombats();

    for (var cid in state.countries) {
      var c = state.countries[cid];
      c.eco += Math.floor(c.ecoIncome * fraction);
      c.ecoIncome = Math.floor(c.eco * 0.05) + (c.industry * 5) + 10;
      if (c.morale < 100) c.morale = Math.min(100, c.morale + 1);
    }

    state.daysElapsed += DAYS_PER_TICK;
    state.tickCount++;

    if (state.daysElapsed >= GAME_DURATION_DAYS) {
      endGame();
      return;
    }

    broadcastGameState();
    // Generate summary then schedule next tick after pause
    generateGlobalSummary(queuedSummary);
    // Schedule next gameplay tick (10s summary display + 30s gameplay)
    scheduleNextTick(SUMMARY_PAUSE_MS + TICK_INTERVAL_MS);
    // Update nextTickAt to AFTER the summary pause for the timer display
    state.nextTickAt = Date.now() + SUMMARY_PAUSE_MS + TICK_INTERVAL_MS;
    state.summaryUntil = Date.now() + SUMMARY_PAUSE_MS;
    broadcastGameState();
  }

  if (pendingProcessing === 0) {
    finishTick();
    return;
  }

  // Execute each player's queued actions sequentially
  sids.forEach(function(sid) {
    var actions = state.queuedActions[sid];
    state.queuedActions[sid] = []; // clear
    var pendingActions = actions.length;
    if (pendingActions === 0) {
      pendingProcessing--;
      if (pendingProcessing === 0) finishTick();
      return;
    }
    actions.forEach(function(act) {
      commandCountry(sid, act.command, act.country, function(result) {
        if (result.ok && result.narrative) {
          queuedSummary.push({ player: act.name, country: act.country, action: act.command, result: result.narrative });
        }
        pendingActions--;
        if (pendingActions === 0) {
          pendingProcessing--;
          if (pendingProcessing === 0) finishTick();
        }
      });
    });
  });
}

var tickTimeout = null;
function scheduleNextTick(delay) {
  if (tickTimeout) clearTimeout(tickTimeout);
  state.nextTickAt = Date.now() + delay;
  tickTimeout = setTimeout(tickWeek, delay);
}
function startTicking() {
  scheduleNextTick(TICK_INTERVAL_MS);
}
function stopTicking() {
  if (tickTimeout) { clearTimeout(tickTimeout); tickTimeout = null; }
}

function generateGlobalSummary(playerActions) {
  playerActions = playerActions || [];

  if (!anthropic) {
    // Simple fallback summary based on player actions
    var msg;
    if (playerActions.length > 0) {
      msg = playerActions.map(function(a){ return a.player + ' (' + a.country + '): ' + a.result; }).join(' · ');
    } else {
      msg = 'La semana transcurre sin grandes movimientos. Los lideres mundiales observan.';
    }
    io.emit('summary', { date: fmtDate(getCurrentDate()), text: msg });
    addLog('📜 ' + msg);
    return;
  }

  // Build context focusing on player countries
  var playerCountries = [];
  for (var sid in state.players) {
    var pp = state.players[sid];
    if (pp.country) playerCountries.push({ name: pp.name, country: pp.country, displayName: state.countries[pp.country] ? state.countries[pp.country].displayName : pp.country });
  }

  var actionsText = playerActions.length > 0
    ? 'Acciones de los jugadores esta semana:\n' + playerActions.map(function(a){
        return '- ' + a.player + ' (' + a.country + ') ordeno: "' + a.action + '" -> ' + a.result;
      }).join('\n')
    : 'Ningun jugador tomo acciones esta semana.';

  var playersText = playerCountries.map(function(p){ return p.name + ' lidera ' + p.displayName; }).join(', ');

  var sysPrompt = 'Sos el narrador del juego de estrategia mundial. Fecha: ' + fmtDate(getCurrentDate()) + '. Escenario: ' + (state.scenario === '1936' ? '1936' : '2026') + '.\n' +
    'JUGADORES: ' + playersText + '\n\n' +
    actionsText + '\n\n' +
    'Generas un resumen narrativo breve (3-4 oraciones, dramatico, en español, tono periodistico-historico) de lo que paso esta semana. ' +
    'IMPORTANTE: Foca en los paises de los JUGADORES, mencionalos por nombre y país. Narra las consecuencias de sus acciones. ' +
    'Si no hubo acciones, describe el ambiente politico y lo que hacen los demas paises. ' +
    'Mantene a los jugadores como protagonistas. NO menciones numeros exactos.';

  anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 350,
    system: sysPrompt,
    messages: [{ role: 'user', content: 'Resumen de la semana del ' + fmtDate(getCurrentDate()) }]
  }).then(function(resp) {
    var text = resp.content[0].text || 'El mundo continua su curso.';
    io.emit('summary', { date: fmtDate(getCurrentDate()), text: text });
    addLog('📜 ' + text);
  }).catch(function(err) {
    console.error('Summary error:', err.message);
    var fallback = playerActions.length > 0
      ? playerActions.map(function(a){ return a.result; }).join(' · ')
      : 'Semana tranquila en el mundo.';
    io.emit('summary', { date: fmtDate(getCurrentDate()), text: fallback });
  });
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
      var dPower = defender.army + defender.tech * 15 + (defender.defense || 0);
      defender.allies.forEach(function(ally) {
        var a = state.countries[ally];
        if (a) dPower += Math.floor(a.army * 0.1);
      });
      var roll = Math.random() * 0.4 + 0.8;
      aPower *= roll;
      if (aPower > dPower) {
        var lost = Math.floor(attacker.army * 0.15);
        attacker.army -= lost;
        defender.army = Math.floor(defender.army * 0.4);
        defender.morale = Math.max(0, defender.morale - 30);
        // CONQUEST: if defender army is broken, attacker conquers the country
        if (defender.army < 30) {
          defender.owner = attacker.owner; // ownership transfers (visible on map!)
          defender.army = Math.floor(attacker.army * 0.1); // garrison
          attacker.army = Math.floor(attacker.army * 0.85);
          attacker.eco += defender.eco; // loot
          defender.eco = Math.floor(defender.eco * 0.2);
          // Inherit territories
          defender.territories.forEach(function(t){
            if (attacker.territories.indexOf(t) === -1) attacker.territories.push(t);
          });
          // End war between them
          attacker.war = attacker.war.filter(function(x){return x!==targetId;});
          defender.war = defender.war.filter(function(x){return x!==cid;});
          addLog('🏴 ' + attacker.displayName + ' CONQUISTO ' + defender.displayName + '!');
        } else {
          addLog(attacker.displayName + ' golpeo a ' + defender.displayName + ' (ataque exitoso)');
        }
      } else {
        attacker.army = Math.floor(attacker.army * 0.6);
        defender.army -= Math.floor(defender.army * 0.1);
        defender.morale = Math.min(100, (defender.morale || 0) + 5);
        addLog(attacker.displayName + ' fue REPELIDO por ' + defender.displayName);
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

// Queue an action - doesn't execute until tick
function queueAction(sid, command, fallbackCountry, callback) {
  var p = state.players[sid];
  if (!p) {
    p = state.players[sid] = { name: 'Lider', color: PLAYER_COLORS[0], country: fallbackCountry || null };
  }
  if (!p.country && fallbackCountry) {
    p.country = fallbackCountry;
    if (state.countries[fallbackCountry] && !state.countries[fallbackCountry].owner) {
      state.countries[fallbackCountry].owner = sid;
    }
  }
  if (!p.country) return callback({ ok: false, msg: 'Elegi un pais primero' });

  if (!state.queuedActions[sid]) state.queuedActions[sid] = [];
  state.queuedActions[sid].push({ command: command, country: p.country, name: p.name });

  callback({ ok: true, queued: true, count: state.queuedActions[sid].length });
}

// Execute a single command via AI (called by tick)
function commandCountry(sid, command, fallbackCountry, callback) {
  var p = state.players[sid];
  if (!p) {
    p = state.players[sid] = { name: 'Lider', color: PLAYER_COLORS[0], country: fallbackCountry || null };
  }
  if (!p.country && fallbackCountry) {
    p.country = fallbackCountry;
    if (state.countries[fallbackCountry] && !state.countries[fallbackCountry].owner) {
      state.countries[fallbackCountry].owner = sid;
    }
  }
  if (!p.country) return callback({ ok: false, msg: 'Elegi un pais primero (volve al lobby)' });
  var mine = state.countries[p.country];
  if (!mine) return callback({ ok: false, msg: 'Pais no encontrado' });

  if (anthropic) {
    // Build global context
    var nearbyCountries = [];
    var neighbors = WORLD.neighbors[p.country] || [];
    neighbors.forEach(function(nid) {
      var n = state.countries[nid];
      if (n) nearbyCountries.push(n.displayName + ' (' + nid + ', ' + approxStat(n.army) + ')');
    });

    var allCountriesBrief = [];
    for (var cid in state.countries) {
      if (cid === p.country) continue;
      var c = state.countries[cid];
      if (c.owner || c.army > 200 || mine.allies.indexOf(cid) !== -1 || mine.war.indexOf(cid) !== -1) {
        allCountriesBrief.push(c.displayName + ' (' + cid + ')');
      }
    }

    var sysPrompt = 'Sos el narrador y asesor de ' + mine.displayName + ' en ' + (state.scenario === '1936' ? '1936 (visperas WWII)' : '2026 (tension moderna)') + ', fecha ' + fmtDate(getCurrentDate()) + '.\n\n' +
      'TU PAIS: ' + mine.displayName + ' (ID: ' + p.country + ')\n' +
      '- Aliados actuales: ' + (mine.allies.join(', ')||'ninguno') + '\n' +
      '- En guerra con: ' + (mine.war.join(', ')||'nadie') + '\n' +
      'VECINOS: ' + (nearbyCountries.join(', ') || 'ninguno') + '\n' +
      'POTENCIAS: ' + allCountriesBrief.slice(0,15).join(', ') + '\n\n' +
      'El jugador da una orden en lenguaje natural. TODA orden es VALIDA y se ejecuta. Tu trabajo es narrar dramaticamente que pasa y devolver el JSON con efectos.\n\n' +
      'NUNCA rechaces una orden por "recursos insuficientes" o "no tienes suficiente oro". El estado tiene recursos abstractos. Vos decidis las consecuencias narrativas.\n\n' +
      'Si la orden es muy ambiciosa (ej: "construir 1000 fabricas"), narra el costo politico/social pero ejecutala. Si es absurda (ej: "ir a Marte"), narra que se intenta pero no funciona.\n\n' +
      'EFECTOS POSIBLES (en selfChanges, todos opcionales, pueden ser negativos o positivos):\n' +
      'army, navy, eco, industry, defense, morale, tech\n\n' +
      'OTROS EFECTOS:\n' +
      '- Declarar guerra: agrega pais a "newWar"\n' +
      '- Formar alianza: agrega a "newAlly"\n' +
      '- Hacer paz: agrega a "endWar"\n' +
      '- Atacar otro pais: usa "targetCountry" y "targetChanges" (army: -X, morale: -X)\n' +
      '- CONQUISTAR un pais (invasion exitosa, ocupacion, anexion): usa "conquer": ["ESP", "FRA"]. Esto transfiere la propiedad del pais al jugador y se ve en el mapa. SOLO usalo si la accion es claramente una invasion exitosa o una conquista contundente. Considera el balance: si tu ejercito es mucho mayor que el del defensor (al menos 1.5x), la conquista tiene exito. Si es similar o menor, NO conquistas (solo dañas).\n\n' +
      'Devolve SOLO JSON valido:\n' +
      '{\n' +
      '  "valid": true,\n' +
      '  "selfChanges": {"army": 100, "morale": -5},\n' +
      '  "targetCountry": "DEU",\n' +
      '  "targetChanges": {"army": -50},\n' +
      '  "newWar": ["DEU"],\n' +
      '  "conquer": ["ESP"],\n' +
      '  "narrative": "descripcion breve dramatica en español, 2-3 oraciones"\n' +
      '}\n' +
      'IMPORTANTE: SIEMPRE valid:true. Usa SOLO los IDs ISO (USA, DEU, FRA, etc).';

    anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: sysPrompt,
      messages: [{ role: 'user', content: command }]
    }).then(function(resp) {
      var text = resp.content[0].text || '{}';
      var match = text.match(/\{[\s\S]*\}/);
      if (!match) return callback({ ok: false, msg: 'Respuesta invalida' });
      try {
        var result = JSON.parse(match[0]);
        applyGlobalCommand(p.country, mine, result, callback);
      } catch (e) {
        callback({ ok: false, msg: 'Error parseando' });
      }
    }).catch(function(err) {
      console.error('Claude error:', err.message);
      var fallback = parseCommandFallback(mine, command);
      applyGlobalCommand(p.country, mine, fallback, callback);
    });
  } else {
    var fallback2 = parseCommandFallback(mine, command);
    applyGlobalCommand(p.country, mine, fallback2, callback);
  }
}

function applyGlobalCommand(myCid, mine, result, callback) {
  // Always apply - never reject by resources. AI is the source of truth.
  if (result.selfChanges) {
    for (var k2 in result.selfChanges) {
      mine[k2] = (mine[k2] || 0) + result.selfChanges[k2];
      clampStat(mine, k2);
    }
  }

  // Apply target country changes
  if (result.targetCountry && result.targetChanges && state.countries[result.targetCountry]) {
    var t = state.countries[result.targetCountry];
    for (var k3 in result.targetChanges) {
      t[k3] = (t[k3] || 0) + result.targetChanges[k3];
      clampStat(t, k3);
    }
  }

  // New wars
  if (result.newWar && Array.isArray(result.newWar)) {
    result.newWar.forEach(function(wid) {
      var w = state.countries[wid];
      if (!w || wid === myCid) return;
      if (mine.war.indexOf(wid) === -1) mine.war.push(wid);
      if (w.war.indexOf(myCid) === -1) w.war.push(myCid);
      mine.allies = mine.allies.filter(function(x){return x!==wid;});
      w.allies = w.allies.filter(function(x){return x!==myCid;});
    });
  }

  // New allies
  if (result.newAlly && Array.isArray(result.newAlly)) {
    result.newAlly.forEach(function(aid) {
      var a = state.countries[aid];
      if (!a || aid === myCid) return;
      if (mine.allies.indexOf(aid) === -1) mine.allies.push(aid);
      if (a.allies.indexOf(myCid) === -1) a.allies.push(myCid);
    });
  }

  // End wars
  if (result.endWar && Array.isArray(result.endWar)) {
    result.endWar.forEach(function(wid) {
      mine.war = mine.war.filter(function(x){return x!==wid;});
      var w = state.countries[wid];
      if (w) w.war = w.war.filter(function(x){return x!==myCid;});
    });
  }

  // CONQUEST: transfers ownership of target country to current player (visible on map!)
  if (result.conquer && Array.isArray(result.conquer)) {
    result.conquer.forEach(function(targetId) {
      var target = state.countries[targetId];
      if (!target || targetId === myCid) return;
      // Cannot conquer another player's country instantly via AI - only bot countries
      if (target.owner && target.owner !== mine.owner) return;
      target.owner = mine.owner; // ownership transfers
      target.controlledBy = myCid;
      target.army = Math.max(20, Math.floor(target.army * 0.3)); // garrison
      target.morale = 40;
      mine.eco += Math.floor(target.eco * 0.5); // war loot
      target.eco = Math.floor(target.eco * 0.3);
      // Inherit territories
      target.territories.forEach(function(t){
        if (mine.territories.indexOf(t) === -1) mine.territories.push(t);
      });
      // End war between them
      mine.war = mine.war.filter(function(x){return x!==targetId;});
      target.war = target.war.filter(function(x){return x!==myCid;});
      addLog('🏴 ' + mine.displayName + ' CONQUISTO ' + target.displayName + '!');
    });
  }

  addLog(mine.displayName + ': ' + (result.narrative || 'accion ejecutada'));
  callback({ ok: true, narrative: result.narrative || 'Accion ejecutada' });
  broadcastGameState();
}

function clampStat(c, key) {
  if (c[key] < 0) c[key] = 0;
  if (key === 'morale' && c[key] > 100) c[key] = 100;
  if (key === 'tech' && c[key] > 10) c[key] = 10;
}

function parseCommandFallback(mine, cmd) {
  // Without AI we accept anything but with minimal effects - always succeeds
  var c = cmd.toLowerCase();
  var numMatch = c.match(/(\d+)/);
  var n = numMatch ? parseInt(numMatch[1]) : 10;

  if (c.indexOf('fabrica') !== -1 || c.indexOf('industria') !== -1 || c.indexOf('planta') !== -1) {
    return { valid: true, selfChanges: { industry: n }, narrative: 'Se ordena la construccion de ' + n + ' fabricas' };
  }
  if (c.indexOf('tropa') !== -1 || c.indexOf('soldado') !== -1 || c.indexOf('reclut') !== -1) {
    return { valid: true, selfChanges: { army: n }, narrative: 'Se reclutan ' + n + ' tropas adicionales' };
  }
  if (c.indexOf('barco') !== -1 || c.indexOf('marina') !== -1 || c.indexOf('flota') !== -1 || c.indexOf('naval') !== -1) {
    return { valid: true, selfChanges: { navy: n }, narrative: 'Astilleros entregan ' + n + ' navios' };
  }
  if (c.indexOf('fortific') !== -1 || c.indexOf('frontera') !== -1 || c.indexOf('defens') !== -1 || c.indexOf('muralla') !== -1) {
    return { valid: true, selfChanges: { defense: 20 }, narrative: 'Las fronteras se fortifican' };
  }
  if (c.indexOf('tecnolog') !== -1 || c.indexOf('investig') !== -1 || c.indexOf('ciencia') !== -1) {
    return { valid: true, selfChanges: { tech: 1 }, narrative: 'Se logra un avance tecnologico' };
  }
  if (c.indexOf('propag') !== -1 || c.indexOf('moral') !== -1) {
    return { valid: true, selfChanges: { morale: 10 }, narrative: 'Campaña de propaganda lanzada' };
  }
  // Generic action - just narrate it
  return { valid: true, selfChanges: {}, narrative: 'Se da la orden: ' + cmd };
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
  stopTicking();
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
  var dateStr = state.phase === 'playing' ? fmtDate(getCurrentDate()) : '';
  state.log.push({ time: Date.now(), msg: msg, date: dateStr });
  if (state.log.length > 50) state.log.shift();
  io.emit('log', { msg: msg, date: dateStr });
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
    if (!p) {
      // Auto-create player if missing (reconnect case)
      p = state.players[socket.id] = { name: 'Lider', color: PLAYER_COLORS[Object.keys(state.players).length % 4], country: null };
    }
    // Allow selecting country during playing phase too if no other player has it
    for (var sid in state.players) {
      if (sid !== socket.id && state.players[sid].country === data.country) return socket.emit('error', { msg: 'Pais ya tomado' });
    }
    p.country = data.country;
    // If game already running, take ownership
    if (state.phase === 'playing' && state.countries[data.country] && !state.countries[data.country].owner) {
      state.countries[data.country].owner = socket.id;
    }
    broadcastLobby();
    if (state.phase === 'playing') broadcastGameState();
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

  // (auto-advance now - no manual nextTurn)

  socket.on('countryChat', function(data) {
    var msg = (data.msg || '').substring(0, 300);
    if (!msg || !data.country) return;
    getCountryChat(socket.id, data.country, msg, function(reply) {
      socket.emit('countryReply', { country: data.country, text: reply.text, from: reply.from });
    });
  });

  socket.on('commandCountry', function(data) {
    var msg = (data.msg || '').substring(0, 300);
    if (!msg) return;
    queueAction(socket.id, msg, data.country, function(result) {
      socket.emit('commandResult', result);
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
