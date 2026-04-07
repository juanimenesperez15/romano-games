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
  for (var psid in state.players) {
    var myPlayer = state.players[psid];
    var snap = {
      turn: state.turn,
      maxTurns: MAX_TURNS,
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

  // Economy income (each turn = 1 year)
  for (var cid in state.countries) {
    var c = state.countries[cid];
    c.eco += c.ecoIncome;
    // Industry boosts income over time
    c.ecoIncome = Math.floor(c.eco * 0.05) + (c.industry * 5) + 10;
    // Morale recovers slowly
    if (c.morale < 100) c.morale = Math.min(100, c.morale + 2);
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

// ── Global AI Command System: player gives free-text orders, AI handles everything ──
function commandCountry(sid, command, callback) {
  var p = state.players[sid];
  if (!p || !p.country) return callback({ ok: false, msg: 'No estas en juego' });
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

    var sysPrompt = 'Sos el asesor estrategico supremo de ' + mine.displayName + ' en ' + (state.scenario === '1936' ? '1936 (visperas WWII)' : '2026 (tension moderna)') + ', año ' + state.turn + ' del juego.\n\n' +
      'TU PAIS:\n' +
      '- ID: ' + p.country + '\n' +
      '- Oro: ' + mine.eco + ' (ingreso: ' + mine.ecoIncome + '/año)\n' +
      '- Ejercito: ' + mine.army + ' tropas\n' +
      '- Marina: ' + mine.navy + ' barcos\n' +
      '- Tecnologia: ' + mine.tech + '/10\n' +
      '- Industria: ' + mine.industry + ' fabricas\n' +
      '- Defensa fronteriza: ' + mine.defense + '\n' +
      '- Moral: ' + mine.morale + '/100\n' +
      '- Aliados: ' + (mine.allies.join(', ')||'ninguno') + '\n' +
      '- En guerra con: ' + (mine.war.join(', ')||'nadie') + '\n\n' +
      'PAISES VECINOS: ' + (nearbyCountries.join(', ') || 'ninguno') + '\n' +
      'POTENCIAS RELEVANTES: ' + allCountriesBrief.slice(0,15).join(', ') + '\n\n' +
      'El jugador da una orden en lenguaje natural. Vos interpretas, evaluas consecuencias geopoliticas realistas, y devolves JSON con los efectos.\n\n' +
      'TIPOS DE ACCIONES POSIBLES (entre otras):\n' +
      '• Construccion: fabricas (100 oro c/u, +1 industria), puertos, aeropuertos, universidades\n' +
      '• Militar: reclutar tropas (2 oro c/u), construir barcos (30 oro c/u), fortificar (150 oro, +20 defensa)\n' +
      '• Tecnologia: investigacion (500 oro, +1 tech)\n' +
      '• Sociedad: propaganda (+10 moral, 50 oro), reformas, censura\n' +
      '• Diplomacia: declarar guerra, proponer alianza, romper tratado, expulsar embajador\n' +
      '• Comercio: enviar oro a otro pais, embargo, sanciones\n' +
      '• Militar ofensivo: invadir vecino (gasta tropas, puede tomar territorio si gana)\n' +
      '• Espionaje: sabotaje, robar tecnologia\n' +
      '• Cualquier otra accion creativa\n\n' +
      'CONSECUENCIAS A CONSIDERAR:\n' +
      '- Declarar guerra baja relacion al maximo, puede activar alianzas enemigas\n' +
      '- Atacar sin razon baja tu moral y la opinion mundial\n' +
      '- Comerciar mejora relaciones\n' +
      '- Invadir solo funciona si sos vecino y tenes ejercito suficiente\n' +
      '- En combate: comparas tu ejercito+tech vs el suyo+defensa, hay random\n\n' +
      'Devolve SOLO JSON valido (sin markdown, sin texto extra):\n' +
      '{\n' +
      '  "valid": true,\n' +
      '  "selfChanges": {"eco": -200, "army": 100},\n' +
      '  "targetCountry": "DEU",\n' +
      '  "targetChanges": {"army": -50, "morale": -10},\n' +
      '  "newWar": ["DEU"],\n' +
      '  "newAlly": [],\n' +
      '  "narrative": "descripcion breve dramatica en español"\n' +
      '}\n' +
      'Si invalido o no afford:\n' +
      '{"valid": false, "reason": "explicacion breve"}\n' +
      'Campos opcionales: targetCountry, targetChanges, newWar (array), newAlly (array), endWar (array).\n' +
      'IMPORTANTE: usa SOLO los IDs ISO de paises (USA, DEU, FRA, etc).';

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
  if (!result.valid) {
    return callback({ ok: false, msg: result.reason || 'Orden invalida' });
  }

  // Apply self changes
  if (result.selfChanges) {
    // Validate negative cost
    for (var k in result.selfChanges) {
      var delta = result.selfChanges[k];
      if (delta < 0 && (mine[k] || 0) + delta < 0) {
        return callback({ ok: false, msg: 'Recursos insuficientes para ' + k });
      }
    }
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
  var c = cmd.toLowerCase();
  var numMatch = c.match(/(\d+)/);
  var n = numMatch ? parseInt(numMatch[1]) : 1;

  if (c.indexOf('fabrica') !== -1 || c.indexOf('industria') !== -1 || c.indexOf('planta') !== -1) {
    var cost = n * 100;
    if (mine.eco < cost) return { valid: false, reason: 'Necesitas ' + cost + ' oro' };
    return { valid: true, selfChanges: { eco: -cost, industry: n }, narrative: 'Construidas ' + n + ' fabricas' };
  }
  if (c.indexOf('tropa') !== -1 || c.indexOf('soldado') !== -1 || c.indexOf('reclut') !== -1) {
    var cost2 = n * 2;
    if (mine.eco < cost2) return { valid: false, reason: 'Necesitas ' + cost2 + ' oro' };
    return { valid: true, selfChanges: { eco: -cost2, army: n }, narrative: 'Reclutadas ' + n + ' tropas' };
  }
  if (c.indexOf('barco') !== -1 || c.indexOf('marina') !== -1 || c.indexOf('flota') !== -1 || c.indexOf('naval') !== -1) {
    var cost3 = n * 30;
    if (mine.eco < cost3) return { valid: false, reason: 'Necesitas ' + cost3 + ' oro' };
    return { valid: true, selfChanges: { eco: -cost3, navy: n }, narrative: 'Construidos ' + n + ' barcos' };
  }
  if (c.indexOf('fortific') !== -1 || c.indexOf('frontera') !== -1 || c.indexOf('defens') !== -1 || c.indexOf('muralla') !== -1) {
    if (mine.eco < 150) return { valid: false, reason: 'Necesitas 150 oro' };
    return { valid: true, selfChanges: { eco: -150, defense: 20 }, narrative: 'Fronteras fortificadas' };
  }
  if (c.indexOf('tecnolog') !== -1 || c.indexOf('investig') !== -1 || c.indexOf('ciencia') !== -1) {
    if (mine.eco < 500) return { valid: false, reason: 'Necesitas 500 oro' };
    if (mine.tech >= 10) return { valid: false, reason: 'Tecnologia al maximo' };
    return { valid: true, selfChanges: { eco: -500, tech: 1 }, narrative: 'Avance tecnologico logrado' };
  }
  if (c.indexOf('propag') !== -1 || c.indexOf('moral') !== -1) {
    if (mine.eco < 50) return { valid: false, reason: 'Necesitas 50 oro' };
    return { valid: true, selfChanges: { eco: -50, morale: 10 }, narrative: 'Campaña de propaganda lanzada' };
  }
  return { valid: false, reason: 'Sin Claude AI activa, solo soporto: fabricas, tropas, barcos, fortificar, tecnologia, propaganda. Activa ANTHROPIC_API_KEY en Railway para AI completa.' };
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

  socket.on('commandCountry', function(data) {
    var msg = (data.msg || '').substring(0, 300);
    if (!msg) return;
    commandCountry(socket.id, msg, function(result) {
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
