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
    partial: {}, // iso -> { by: sid, level: 1|2|3 } - partial occupation visible on map
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
      partial: state.partial || {},
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

  // Notify clients we are processing this tick — client opens summary modal
  // immediately with a "Calculando semana..." state, so no perceived lag.
  io.emit('tickProcessing', { at: Date.now() });

  var queuedSummary = []; // for AI global summary
  var sids = Object.keys(state.queuedActions);
  var pendingProcessing = sids.length;
  var processingDone = false;

  function finishTick() {
    if (processingDone) return; // safeguard against double-fire from timeout race
    processingDone = true;

    var botEvents = runBotsTurn(); // bots take visible actions, returns notable events
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
    // Generate summary; when it arrives, schedule the next tick. The summary
    // window starts only AFTER the summary actually arrives, so the visible
    // "calculating" time and the 10s reading time don't double up.
    generateGlobalSummary(queuedSummary, botEvents, function() {
      state.summaryUntil = Date.now() + SUMMARY_PAUSE_MS;
      scheduleNextTick(SUMMARY_PAUSE_MS + TICK_INTERVAL_MS);
      broadcastGameState();
    });
  }

  // Hard timeout: if Claude takes more than 12 seconds, force-finish so the
  // game never freezes waiting on the API.
  var hardTimeout = setTimeout(function() {
    if (!processingDone) {
      console.log('[world] tick processing timeout, forcing finish');
      finishTick();
    }
  }, 12000);

  if (pendingProcessing === 0) {
    clearTimeout(hardTimeout);
    finishTick();
    return;
  }

  // Execute each player's queued actions in parallel
  sids.forEach(function(sid) {
    var actions = state.queuedActions[sid];
    state.queuedActions[sid] = []; // clear
    var pendingActions = actions.length;
    if (pendingActions === 0) {
      pendingProcessing--;
      if (pendingProcessing === 0) { clearTimeout(hardTimeout); finishTick(); }
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
          if (pendingProcessing === 0) { clearTimeout(hardTimeout); finishTick(); }
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

function generateGlobalSummary(playerActions, botEvents, done) {
  playerActions = playerActions || [];
  botEvents = botEvents || [];
  done = done || function(){};

  function emit(text) {
    io.emit('summary', { date: fmtDate(getCurrentDate()), text: text });
    addLog('📜 ' + text);
    done();
  }

  if (!anthropic) {
    var parts = [];
    playerActions.forEach(function(a){ parts.push(a.player + ' (' + a.country + '): ' + a.result); });
    botEvents.forEach(function(e){ parts.push(e); });
    var msg = parts.length ? parts.join(' · ') : 'Semana sin grandes movimientos.';
    if (msg.length > 180) msg = msg.substring(0, 177) + '...';
    return emit(msg);
  }

  var playerCountries = [];
  for (var sid in state.players) {
    var pp = state.players[sid];
    if (pp.country) playerCountries.push({ name: pp.name, country: pp.country, displayName: state.countries[pp.country] ? state.countries[pp.country].displayName : pp.country });
  }

  var actionsText = playerActions.length > 0
    ? 'Jugadores:\n' + playerActions.map(function(a){
        return '- ' + a.player + ' (' + a.country + '): ' + a.result;
      }).join('\n')
    : 'Ningun jugador actuo.';
  var botText = botEvents.length > 0
    ? '\nOtras potencias:\n' + botEvents.map(function(e){ return '- ' + e; }).join('\n')
    : '';
  var playersText = playerCountries.map(function(p){ return p.name + ' lidera ' + p.displayName; }).join(', ');

  var sysPrompt = 'Sos un titular de prensa de un juego de estrategia mundial. Fecha: ' + fmtDate(getCurrentDate()) + '. Escenario: ' + (state.scenario === '1936' ? '1936' : '2026') + '.\n' +
    'JUGADORES: ' + playersText + '\n\n' +
    actionsText + botText + '\n\n' +
    'REGLAS ESTRICTAS:\n' +
    '- MAXIMO 25 palabras. Una oracion potente o dos cortas.\n' +
    '- Tono titular de diario (ej: "Berlin moviliza divisiones. Paris responde con silencio").\n' +
    '- Mencionas TANTO acciones de jugadores como movimientos de las otras potencias (no solo jugadores).\n' +
    '- Sin numeros, sin parrafos. Solo el titular.';

  // Soft timeout: if Claude is slow, fall back so the user never waits forever
  var fired = false;
  var softTimeout = setTimeout(function() {
    if (fired) return;
    fired = true;
    var fb = (playerActions[0] && playerActions[0].result) || botEvents[0] || 'El mundo se reordena en silencio.';
    if (fb.length > 140) fb = fb.substring(0, 137) + '...';
    emit(fb);
  }, 7000);

  anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 120,
    system: sysPrompt,
    messages: [{ role: 'user', content: 'Titular del ' + fmtDate(getCurrentDate()) + ' (max 25 palabras)' }]
  }).then(function(resp) {
    if (fired) return;
    fired = true;
    clearTimeout(softTimeout);
    var text = resp.content[0].text || 'El mundo continua su curso.';
    emit(text);
  }).catch(function(err) {
    if (fired) return;
    fired = true;
    clearTimeout(softTimeout);
    console.error('Summary error:', err.message);
    var fallback = playerActions.length > 0
      ? playerActions.map(function(a){ return a.result; }).join(' · ')
      : (botEvents[0] || 'Semana tranquila en el mundo.');
    if (fallback.length > 140) fallback = fallback.substring(0, 137) + '...';
    emit(fallback);
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

// Shared helper: a country (player or bot) advances its occupation of target.
// Returns a short narrative describing the result, or null if it didn't happen.
function advancePartialConquest(attackerCid, targetId) {
  var attacker = state.countries[attackerCid];
  var target = state.countries[targetId];
  if (!attacker || !target || targetId === attackerCid) return null;
  // Bots can't conquer player territory directly via this path
  if (target.owner && target.owner !== attacker.owner) return null;
  var cur = state.partial[targetId];
  if (cur && cur.byCid !== attackerCid) {
    // Different invader already there — front line shifts, restart progress
    cur = null;
  }
  if (!cur) cur = state.partial[targetId] = { byCid: attackerCid, level: 0 };
  cur.level += 1;
  target.morale = Math.max(0, target.morale - 18);
  target.army = Math.floor(target.army * 0.75);
  attacker.army = Math.floor(attacker.army * 0.92);
  if (cur.level >= 3) {
    delete state.partial[targetId];
    target.owner = attacker.owner;
    target.controlledBy = attackerCid;
    target.army = Math.max(20, Math.floor(target.army * 0.5));
    target.morale = 40;
    attacker.eco += Math.floor(target.eco * 0.5);
    target.eco = Math.floor(target.eco * 0.3);
    target.territories.forEach(function(t){
      if (attacker.territories.indexOf(t) === -1) attacker.territories.push(t);
    });
    attacker.war = attacker.war.filter(function(x){return x!==targetId;});
    target.war = target.war.filter(function(x){return x!==attackerCid;});
    addLog('🏴 ' + attacker.displayName + ' CONQUISTO ' + target.displayName + '!');
    return attacker.displayName + ' anexa ' + target.displayName;
  }
  addLog('⚔ ' + attacker.displayName + ' avanza en ' + target.displayName + ' (' + cur.level + '/3)');
  return attacker.displayName + ' avanza territorio en ' + target.displayName;
}

// Bots take visible, varied actions every tick: build up, declare wars, propose
// alliances, attack neighbors, send aid. Returns array of notable events for the
// summary and broadcast.
function runBotsTurn() {
  var diffMod = state.difficulty === 'hard' ? 1.5 : (state.difficulty === 'easy' ? 0.6 : 1);
  var events = [];
  var allCids = Object.keys(state.countries);

  // Pick how many bots act notably this tick (most stay passive, ~4-7 act)
  var actCount = 4 + Math.floor(Math.random() * 4);
  var pool = allCids.filter(function(cid) {
    var c = state.countries[cid];
    return c && !c.owner; // bots only
  });
  // Shuffle and take actCount
  pool.sort(function(){ return Math.random() - 0.5; });
  var actors = pool.slice(0, actCount);

  // Background: every bot also passively grows
  for (var bi = 0; bi < pool.length; bi++) {
    var bc = state.countries[pool[bi]];
    if (bc.eco > 30 && bc.pers !== 'isolationist') {
      var spend = Math.floor(bc.eco * 0.2 * diffMod);
      bc.eco -= spend;
      bc.army += Math.floor(spend / 2);
    }
  }

  actors.forEach(function(cid) {
    var c = state.countries[cid];
    var pers = c.pers;
    var neighbors = (WORLD.neighbors[cid] || []).filter(function(n){ return state.countries[n]; });

    // Aggressive: declare war and INVADE a weaker neighbor (advances partial conquest)
    if (pers === 'aggressive' && neighbors.length && c.army > 80) {
      var weakest = null, weakestArmy = Infinity;
      neighbors.forEach(function(n) {
        var nc = state.countries[n];
        if (nc.army < c.army * 0.85 && nc.army < weakestArmy && !nc.owner) {
          weakest = n; weakestArmy = nc.army;
        }
      });
      if (weakest) {
        if (c.war.indexOf(weakest) === -1) {
          c.war.push(weakest);
          state.countries[weakest].war.push(cid);
          events.push(c.displayName + ' declara guerra a ' + state.countries[weakest].displayName);
        }
        var msg = advancePartialConquest(cid, weakest);
        if (msg) events.push(msg);
        return;
      }
    }

    // Diplomatic: propose alliance with strongest peaceful neighbor
    if (pers === 'diplomatic' && neighbors.length) {
      var allyCandidate = null;
      neighbors.forEach(function(n) {
        var nc = state.countries[n];
        if (c.allies.indexOf(n) === -1 && c.war.indexOf(n) === -1 && (!allyCandidate || nc.army > state.countries[allyCandidate].army)) {
          allyCandidate = n;
        }
      });
      if (allyCandidate) {
        c.allies.push(allyCandidate);
        state.countries[allyCandidate].allies.push(cid);
        events.push(c.displayName + ' firma pacto con ' + state.countries[allyCandidate].displayName);
        return;
      }
    }

    // Defensive: fortify, big morale boost
    if (pers === 'defensive') {
      c.defense = (c.defense || 0) + 25;
      c.morale = Math.min(100, c.morale + 10);
      events.push(c.displayName + ' refuerza sus fronteras');
      return;
    }

    // Economic: industrialize
    if (pers === 'economic') {
      c.industry = (c.industry || 0) + 2;
      c.eco += 60;
      events.push(c.displayName + ' inaugura nuevas fabricas');
      return;
    }

    // Isolationist: rare neutral act
    if (pers === 'isolationist') {
      c.morale = Math.min(100, c.morale + 5);
      events.push(c.displayName + ' cierra fronteras al exterior');
      return;
    }

    // Default: rearm
    c.army += 30;
    events.push(c.displayName + ' moviliza nuevas tropas');
  });

  // Continue advancing existing fronts even when bots aren't "actors" this tick
  for (var pIso in state.partial) {
    var p = state.partial[pIso];
    var byC = state.countries[p.byCid];
    if (!byC || byC.owner) continue; // skip player-led fronts (handled by player commands)
    if (Math.random() < 0.5) {
      var msg2 = advancePartialConquest(p.byCid, pIso);
      if (msg2 && events.indexOf(msg2) === -1) events.push(msg2);
    }
  }

  return events;
}

// ── Country chat with AI ──
// Each country has its own personality, current state, recent events and remembers
// the conversation with each player so it feels autonomous, not generic.
var PERSONALITY_PROFILES = {
  aggressive: 'Lider militarista, expansionista, desconfia de promesas, valora la fuerza, suele amenazar.',
  defensive: 'Lider cauteloso, prioriza estabilidad, evita guerras pero responde con dureza si lo provocan.',
  diplomatic: 'Lider negociador habil, busca alianzas, propone tratos, ofrece compromiso.',
  economic: 'Lider mercantilista, calcula todo en oro, ofrece comercio antes que ejercito.',
  isolationist: 'Lider que rechaza la mayoria de propuestas extranjeras, no quiere entrar en conflictos ajenos.'
};

function describeCountryGoals(country, scenario) {
  // Auto-derived goals based on personality + scenario context
  var g = [];
  if (country.pers === 'aggressive') g.push('expandir el territorio nacional');
  if (country.pers === 'defensive') g.push('reforzar fronteras y disuadir agresiones');
  if (country.pers === 'diplomatic') g.push('tejer una red de alianzas regionales');
  if (country.pers === 'economic') g.push('crecer economicamente y dominar el comercio');
  if (country.pers === 'isolationist') g.push('mantener neutralidad y aislamiento');
  if (scenario === '1936') g.push('posicionarse antes del conflicto que se aproxima');
  else g.push('proteger intereses estrategicos en un mundo multipolar');
  if (country.war.length > 0) g.push('ganar o salir bien de la guerra contra ' + country.war.join(', '));
  return g;
}

function getCountryChat(sid, countryId, userMsg, callback) {
  var country = state.countries[countryId];
  if (!country) return callback({ text: 'Pais no encontrado' });
  var p = state.players[sid];
  if (!p || !p.country) return callback({ text: 'No estas en juego' });
  var mine = state.countries[p.country];

  // Per-pair chat history (player ↔ country) so the lider remembers what was said
  var key = sid + ':' + countryId;
  if (!state.countryChats[key]) state.countryChats[key] = [];
  var history = state.countryChats[key];
  history.push({ role: 'user', text: userMsg });
  if (history.length > 10) history.splice(0, history.length - 10);

  var relationStatus = 'neutrales';
  if (mine.allies.indexOf(countryId) !== -1) relationStatus = 'aliados';
  if (mine.war.indexOf(countryId) !== -1) relationStatus = 'en GUERRA';

  if (anthropic) {
    var profile = PERSONALITY_PROFILES[country.pers] || '';
    var goals = describeCountryGoals(country, state.scenario);
    var armyDesc = approxStat(country.army);
    var econDesc = country.eco > 500 ? 'rico' : (country.eco > 200 ? 'estable' : 'pobre');
    var moraleDesc = country.morale > 70 ? 'pueblo entusiasta' : (country.morale > 40 ? 'pueblo cansado' : 'pueblo al borde de revuelta');
    var alliesText = country.allies.length ? country.allies.join(', ') : 'ninguno';
    var warsText = country.war.length ? country.war.join(', ') : 'nadie';
    var occupiedNote = '';
    if (state.partial[countryId]) {
      occupiedNote = '\nIMPORTANTE: tu pais tiene ' + state.partial[countryId].level + '/3 territorios ocupados por una potencia extranjera. Estas en panico/furia.';
    }

    var sysPrompt = 'Sos el LIDER de ' + country.displayName + ' (' + countryId + ') en ' + (state.scenario === '1936' ? '1936, visperas de la 2da guerra mundial' : '2026, tension moderna multipolar') + '.\n\n' +
      'TU PERSONALIDAD: ' + profile + '\n' +
      'TUS OBJETIVOS ACTUALES: ' + goals.join('; ') + '\n' +
      'ESTADO DE TU NACION: ejercito ' + armyDesc + ', economia ' + econDesc + ', ' + moraleDesc + '.\n' +
      'TUS ALIADOS: ' + alliesText + '\n' +
      'TUS GUERRAS ABIERTAS: ' + warsText + occupiedNote + '\n\n' +
      'HABLAS CON: ' + mine.displayName + ' (' + p.country + '). Relacion entre nuestras naciones: ' + relationStatus + '.\n' +
      'Su ejercito esta ' + approxStat(mine.army) + '. Su personalidad ' + (mine.pers || 'desconocida') + '.\n\n' +
      'REGLAS:\n' +
      '- Hablas EN PRIMERA PERSONA como ese lider, no como narrador.\n' +
      '- 1 a 3 frases. Concretas, con personalidad MARCADA.\n' +
      '- Tomas DECISIONES propias: aceptas, rechazas, contraproponen, ponen condiciones. NUNCA respondas algo generico tipo "lo consideraremos".\n' +
      '- Si te conviene, regateas. Si no, mandas al diablo. Pones precio o territorio en cada trato.\n' +
      '- Recordas lo que se dijo antes en esta conversacion.\n' +
      '- En español. Sin markdown ni emojis.';

    var msgs = history.map(function(h) {
      return { role: h.role === 'user' ? 'user' : 'assistant', content: h.text };
    });
    anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 220,
      system: sysPrompt,
      messages: msgs
    }).then(function(resp) {
      var text = resp.content[0].text || '...';
      history.push({ role: 'assistant', text: text });
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
      '- INVADIR / OCUPAR territorio (invasion, ofensiva, ataque terrestre): usa "conquer": ["ESP"]. Esto NO conquista el pais entero, solo ocupa UN TERRITORIO/region. Hacen falta 3 invasiones exitosas para conquistar el pais completo (cada una avanza un territorio en el mapa). Considera el balance: si tu ejercito es mayor (>1.2x del defensor) la ofensiva avanza. Si no, NO uses conquer (solo daña con targetChanges).\n\n' +
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
      max_tokens: 350,
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

  // PARTIAL CONQUEST: each successful invasion advances occupation by 1 territory.
  if (result.conquer && Array.isArray(result.conquer)) {
    result.conquer.forEach(function(targetId) {
      advancePartialConquest(myCid, targetId);
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
    if (!p) return;
    if (state.phase === 'playing') {
      // Keep the slot so the player can rejoin within 5 minutes; country
      // ownership stays put — we just mark them as disconnected.
      p.disconnectedAt = Date.now();
      addChat('Sistema', '#888', p.name + ' se desconecto (puede volver)');
      broadcastLobby();
      var sidCopy = socket.id;
      setTimeout(function() {
        var still = state.players[sidCopy];
        if (still && still.disconnectedAt && Date.now() - still.disconnectedAt >= 299000) {
          if (still.country && state.countries[still.country] && state.countries[still.country].owner === sidCopy) {
            state.countries[still.country].owner = null;
          }
          delete state.players[sidCopy];
          if (state.queuedActions[sidCopy]) delete state.queuedActions[sidCopy];
          broadcastLobby();
        }
      }, 300000);
    } else {
      addChat('Sistema', '#888', p.name + ' se desconecto');
      if (p.country && state.countries[p.country]) state.countries[p.country].owner = null;
      delete state.players[socket.id];
      broadcastLobby();
    }
  });

  // Reconnect to existing session by name. Client sends this on every connect
  // if it has a saved name + country in localStorage.
  socket.on('rejoin', function(data) {
    var name = ((data && data.name) || '').substring(0, 14);
    var country = data && data.country;
    if (!name) return;
    // Find disconnected slot with same name (or even active slot — same name re-attach)
    var oldSid = null;
    for (var sid in state.players) {
      if (sid === socket.id) continue;
      var pp = state.players[sid];
      if (pp.name === name) { oldSid = sid; break; }
    }
    if (!oldSid) {
      // No previous session — ignore silently, normal join flow will handle it
      socket.emit('rejoinResult', { ok: false });
      return;
    }
    var oldPlayer = state.players[oldSid];
    state.players[socket.id] = {
      name: oldPlayer.name,
      color: oldPlayer.color,
      country: oldPlayer.country
    };
    delete state.players[oldSid];
    if (oldPlayer.country && state.countries[oldPlayer.country]) {
      state.countries[oldPlayer.country].owner = socket.id;
    }
    if (state.queuedActions[oldSid]) {
      state.queuedActions[socket.id] = state.queuedActions[oldSid];
      delete state.queuedActions[oldSid];
    }
    addChat('Sistema', '#888', name + ' se reconecto');
    socket.emit('rejoinResult', { ok: true, phase: state.phase, country: oldPlayer.country });
    if (state.phase === 'playing') {
      socket.emit('gameStart', { scenario: state.scenario });
    }
    broadcastLobby();
    if (state.phase === 'playing') broadcastGameState();
  });
});

};
