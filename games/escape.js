module.exports = function (io) {
  const PLAYER_COLORS = ['#EF4444', '#3B82F6', '#22C55E', '#F59E0B'];
  const ROOM_TIME = 240; // 4 minutes per room
  const MAX_HINTS = 3;
  const HINT_PENALTY = 20;
  const MAX_CHAT = 80;

  const ROOMS = [
    { name: 'El Laboratorio', emoji: '🧪', color: '#C084FC' },
    { name: 'La Mansion', emoji: '🏚️', color: '#F472B6' },
    { name: 'La Piramide', emoji: '⚱️', color: '#FB923C' },
  ];

  const PUZZLE_NAMES = [
    ['Mezcla Quimica', 'Panel Electrico'],
    ['Retratos', 'Piano Fantasma'],
    ['Balanza', 'Puerta Final'],
  ];

  let state = resetState();

  function resetState() {
    return {
      phase: 'lobby',
      players: [],
      currentRoom: 0,
      currentPuzzle: 0,
      timer: ROOM_TIME,
      hintsLeft: MAX_HINTS,
      chat: [],
      puzzleData: null,
      solvedPuzzles: 0,
    };
  }

  // ─── Utilities ────────────────────────────────────────────────────

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // Distribute clues: if solo, give all clues to player 0
  function distribute(clues, playerCount) {
    if (playerCount <= 1) return [clues.slice()];
    const buckets = Array.from({ length: playerCount }, () => []);
    clues.forEach((c, i) => buckets[i % playerCount].push(c));
    return buckets;
  }

  // ─── Puzzle Generators ────────────────────────────────────────────

  function generatePuzzle(room, puzzle, playerCount) {
    if (room === 0 && puzzle === 0) return genMezclaQuimica(playerCount);
    if (room === 0 && puzzle === 1) return genPanelElectrico(playerCount);
    if (room === 1 && puzzle === 0) return genRetratos(playerCount);
    if (room === 1 && puzzle === 1) return genPianoFantasma(playerCount);
    if (room === 2 && puzzle === 0) return genBalanza(playerCount);
    if (room === 2 && puzzle === 1) return genPuertaFinal(playerCount);
  }

  // Room 1, Puzzle 1: Mezcla Quimica
  function genMezclaQuimica(playerCount) {
    const FLASKS = [
      { id: 'rojo', label: 'Rojo', color: '#EF4444', warm: true },
      { id: 'azul', label: 'Azul', color: '#3B82F6', warm: false },
      { id: 'verde', label: 'Verde', color: '#22C55E', warm: false },
      { id: 'amarillo', label: 'Amarillo', color: '#F59E0B', warm: true },
      { id: 'morado', label: 'Morado', color: '#A855F7', warm: false },
      { id: 'naranja', label: 'Naranja', color: '#F97316', warm: true },
    ];

    // Pick 3 random flasks for the answer
    const shuffled = shuffle(FLASKS);
    const answer = [shuffled[0], shuffled[1], shuffled[2]];
    const answerStr = answer.map(f => f.id).join(',');

    // Generate clues
    const warmColors = ['rojo', 'amarillo', 'naranja'];
    const coolColors = ['azul', 'verde', 'morado'];

    const clues = [];
    // Clue about position 1
    if (answer[0].warm) {
      clues.push('🔬 El primer ingrediente es de color CALIDO (rojo, amarillo o naranja)');
    } else {
      clues.push('🔬 El primer ingrediente es de color FRIO (azul, verde o morado)');
    }

    // Clue about position 2
    const notSecond = FLASKS.filter(f => f.id !== answer[1].id);
    const decoy1 = pick(notSecond);
    const decoy2 = pick(notSecond.filter(f => f.id !== decoy1.id));
    clues.push(`🔬 El segundo ingrediente NO es ${decoy1.label} ni ${decoy2.label}`);

    // Clue about position 3
    if (answer[2].warm) {
      clues.push('🔬 El ultimo ingrediente es de color CALIDO');
    } else {
      clues.push('🔬 El ultimo ingrediente es de color FRIO');
    }

    // More specific clues
    clues.push(`🔬 ${answer[0].label} aparece en la mezcla`);
    clues.push(`🔬 ${answer[2].label} aparece en la mezcla`);

    // Negative clue
    const notUsed = FLASKS.filter(f => !answer.find(a => a.id === f.id));
    clues.push(`🔬 ${pick(notUsed).label} NO se usa en la mezcla`);

    const perPlayer = distribute(clues, playerCount);

    return {
      answer: answerStr,
      title: 'Mezcla Quimica',
      desc: 'Selecciona 3 frascos en el orden correcto para crear la formula.',
      visual: {
        type: 'flasks',
        flasks: FLASKS.map(f => ({ id: f.id, label: f.label, color: f.color })),
      },
      perPlayer,
      hint: `El primer frasco es ${answer[0].label}`,
    };
  }

  // Room 1, Puzzle 2: Panel Electrico
  function genPanelElectrico(playerCount) {
    // Generate random ON/OFF for 4 switches
    const switches = [0, 1, 2, 3].map(() => (Math.random() < 0.5 ? 1 : 0));
    const answerStr = switches.join('');
    const labels = ['A', 'B', 'C', 'D'];
    const onOff = (v) => (v === 1 ? 'ENCENDIDO' : 'APAGADO');

    const clues = [];
    // Direct clues
    clues.push(`⚡ El interruptor ${labels[0]} debe estar ${onOff(switches[0])}`);
    clues.push(`⚡ El interruptor ${labels[1]} debe estar ${onOff(switches[1])}`);
    clues.push(`⚡ El interruptor ${labels[2]} debe estar ${onOff(switches[2])}`);
    clues.push(`⚡ El interruptor ${labels[3]} debe estar ${onOff(switches[3])}`);

    // Count clue
    const onCount = switches.filter(s => s === 1).length;
    clues.push(`⚡ Exactamente ${onCount} interruptores deben estar ENCENDIDOS`);

    // Relation clue
    if (switches[0] === switches[3]) {
      clues.push('⚡ A y D estan en el mismo estado');
    } else {
      clues.push('⚡ A y D estan en estados OPUESTOS');
    }

    const perPlayer = distribute(clues, playerCount);

    return {
      answer: answerStr,
      title: 'Panel Electrico',
      desc: 'Configura los 4 interruptores en la combinacion correcta.',
      visual: {
        type: 'switches',
        labels: labels,
      },
      perPlayer,
      hint: `El interruptor A debe estar ${onOff(switches[0])}`,
    };
  }

  // Room 2, Puzzle 1: Retratos
  function genRetratos(playerCount) {
    // 5 portraits: abuelo(👴), padre(👨), madre(👩), hija(👧), bebe(👶)
    const portraits = [
      { id: 'abuelo', emoji: '👴', label: 'Abuelo' },
      { id: 'padre', emoji: '👨', label: 'Padre' },
      { id: 'madre', emoji: '👩', label: 'Madre' },
      { id: 'hija', emoji: '👧', label: 'Hija' },
      { id: 'bebe', emoji: '👶', label: 'Bebe' },
    ];

    // Generate a random order (the correct arrangement)
    const order = shuffle([0, 1, 2, 3, 4]); // order[position] = portrait index
    // answer is the portrait ids in order of positions
    const answerArr = order.map(i => portraits[i].id);
    const answerStr = answerArr.join(',');

    // Generate relationship clues based on positions
    const clues = [];
    // Find positions
    const posOf = {};
    order.forEach((pi, pos) => { posOf[portraits[pi].id] = pos; });

    // Clue: X is to the left of Y (lower position)
    if (posOf['abuelo'] < posOf['madre']) {
      clues.push('🖼️ El Abuelo esta a la IZQUIERDA de la Madre');
    } else {
      clues.push('🖼️ El Abuelo esta a la DERECHA de la Madre');
    }

    if (posOf['padre'] < posOf['hija']) {
      clues.push('🖼️ El Padre esta a la IZQUIERDA de la Hija');
    } else {
      clues.push('🖼️ El Padre esta a la DERECHA de la Hija');
    }

    // Direct position clues
    clues.push(`🖼️ ${portraits[order[0]].label} esta en la posicion 1 (izquierda)`);
    clues.push(`🖼️ ${portraits[order[4]].label} esta en la posicion 5 (derecha)`);

    // Adjacency
    for (let i = 0; i < 4; i++) {
      if ((portraits[order[i]].id === 'madre' && portraits[order[i + 1]].id === 'bebe') ||
          (portraits[order[i]].id === 'bebe' && portraits[order[i + 1]].id === 'madre')) {
        clues.push('🖼️ La Madre y el Bebe estan juntos (adyacentes)');
        break;
      }
    }
    // Position clue for middle
    clues.push(`🖼️ ${portraits[order[2]].label} esta en el centro (posicion 3)`);

    // Negative
    const notPos1 = portraits.filter(p => p.id !== portraits[order[0]].id);
    clues.push(`🖼️ ${pick(notPos1).label} NO esta en la posicion 1`);

    const perPlayer = distribute(clues, playerCount);

    return {
      answer: answerStr,
      title: 'Retratos',
      desc: 'Coloca los 5 retratos familiares en el orden correcto.',
      visual: {
        type: 'portraits',
        portraits: portraits.map(p => ({ id: p.id, emoji: p.emoji, label: p.label })),
        slots: 5,
      },
      perPlayer,
      hint: `${portraits[order[0]].label} va en la posicion 1`,
    };
  }

  // Room 2, Puzzle 2: Piano Fantasma
  function genPianoFantasma(playerCount) {
    const NOTES = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si', 'Do2'];
    const NOTE_LABELS = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si', 'Do'];

    // Pick 4 random notes
    const indices = shuffle([0, 1, 2, 3, 4, 5, 6, 7]).slice(0, 4);
    const answer = indices.map(i => NOTES[i]);
    const answerStr = answer.join(',');

    const clues = [];
    // Positional clues
    clues.push(`🎹 La primera nota es ${NOTE_LABELS[indices[0]]}`);
    clues.push(`🎹 La ultima nota es ${NOTE_LABELS[indices[3]]}`);

    // Inclusion
    clues.push(`🎹 ${NOTE_LABELS[indices[1]]} aparece en la melodia`);
    clues.push(`🎹 ${NOTE_LABELS[indices[2]]} aparece en la melodia`);

    // Position hint
    clues.push(`🎹 La segunda nota es ${NOTE_LABELS[indices[1]]}`);

    // Exclusion
    const notUsed = NOTES.filter(n => !answer.includes(n));
    if (notUsed.length > 0) {
      const notIdx = NOTES.indexOf(notUsed[0]);
      clues.push(`🎹 ${NOTE_LABELS[notIdx]} NO aparece en la melodia`);
    }

    // Relative
    if (indices[0] < indices[1]) {
      clues.push('🎹 La segunda nota es mas AGUDA que la primera');
    } else {
      clues.push('🎹 La segunda nota es mas GRAVE que la primera');
    }

    const perPlayer = distribute(clues, playerCount);

    return {
      answer: answerStr,
      title: 'Piano Fantasma',
      desc: 'Toca las 4 notas en el orden correcto para abrir el pasaje secreto.',
      visual: {
        type: 'piano',
        notes: NOTES.map((n, i) => ({ id: n, label: NOTE_LABELS[i] })),
      },
      perPlayer,
      hint: `La primera nota es ${NOTE_LABELS[indices[0]]}`,
    };
  }

  // Room 3, Puzzle 1: Balanza
  function genBalanza(playerCount) {
    const SYMBOLS = [
      { id: 'corona', emoji: '👑', label: 'Corona' },
      { id: 'gema', emoji: '💎', label: 'Gema' },
      { id: 'moneda', emoji: '🪙', label: 'Moneda' },
      { id: 'anillo', emoji: '💍', label: 'Anillo' },
      { id: 'caliz', emoji: '🏆', label: 'Caliz' },
    ];

    // Assign random weights (hidden)
    const weights = shuffle([1, 2, 3, 4, 5]); // index i -> weight
    // Find the heaviest
    const heaviestIdx = weights.indexOf(5);
    const answerStr = SYMBOLS[heaviestIdx].id;

    // Generate comparison clues
    const clues = [];
    const comparisons = [];

    // Generate several comparisons
    for (let i = 0; i < SYMBOLS.length; i++) {
      for (let j = i + 1; j < SYMBOLS.length; j++) {
        if (weights[i] > weights[j]) {
          comparisons.push({
            left: SYMBOLS[i],
            right: SYMBOLS[j],
            leftW: weights[i],
            rightW: weights[j],
          });
        } else {
          comparisons.push({
            left: SYMBOLS[j],
            right: SYMBOLS[i],
            leftW: weights[j],
            rightW: weights[i],
          });
        }
      }
    }

    // Pick some comparisons as clues (enough to be solvable)
    const selected = shuffle(comparisons).slice(0, 6);
    selected.forEach(c => {
      clues.push(`⚖️ ${c.left.emoji} ${c.left.label} pesa MAS que ${c.right.emoji} ${c.right.label}`);
    });

    // Visual data: show the comparisons
    const visualComparisons = selected.map(c => ({
      heavier: { emoji: c.left.emoji, label: c.left.label },
      lighter: { emoji: c.right.emoji, label: c.right.label },
    }));

    const perPlayer = distribute(clues, playerCount);

    return {
      answer: answerStr,
      title: 'Balanza',
      desc: 'Observa las comparaciones de peso. Cual es el objeto MAS pesado?',
      visual: {
        type: 'balance',
        symbols: SYMBOLS.map(s => ({ id: s.id, emoji: s.emoji, label: s.label })),
        comparisons: visualComparisons,
      },
      perPlayer,
      hint: `El objeto mas pesado es ${SYMBOLS[heaviestIdx].label}`,
    };
  }

  // Room 3, Puzzle 2: Puerta Final
  function genPuertaFinal(playerCount) {
    const digits = [randInt(1, 9), randInt(0, 9), randInt(0, 9), randInt(1, 9)];
    const answerStr = digits.join('');

    const clues = [];
    // Math clues
    clues.push(`🔢 El primer digito es ${digits[0]}`);
    clues.push(`🔢 El ultimo digito es ${digits[3]}`);
    clues.push(`🔢 La suma de todos los digitos es ${digits[0] + digits[1] + digits[2] + digits[3]}`);
    clues.push(`🔢 El segundo digito es ${digits[1] % 2 === 0 ? 'PAR' : 'IMPAR'}`);
    clues.push(`🔢 El tercer digito es ${digits[2]}`);
    clues.push(`🔢 El segundo digito es ${digits[1]}`);

    // Relation
    if (digits[0] > digits[1]) {
      clues.push('🔢 El primer digito es MAYOR que el segundo');
    } else if (digits[0] < digits[1]) {
      clues.push('🔢 El primer digito es MENOR que el segundo');
    } else {
      clues.push('🔢 Los dos primeros digitos son IGUALES');
    }

    const perPlayer = distribute(clues, playerCount);

    return {
      answer: answerStr,
      title: 'Puerta Final',
      desc: 'Ingresa el codigo de 4 digitos para abrir la puerta y escapar!',
      visual: {
        type: 'code',
        length: 4,
      },
      perPlayer,
      hint: `Los dos primeros digitos son ${digits[0]} y ${digits[1]}`,
    };
  }

  // ─── Game Logic ───────────────────────────────────────────────────

  function startPuzzle() {
    const pc = state.players.length;
    state.puzzleData = generatePuzzle(state.currentRoom, state.currentPuzzle, pc);
  }

  function sendPuzzleToPlayers() {
    if (!state.puzzleData) return;
    const pd = state.puzzleData;
    state.players.forEach((player, index) => {
      const socket = io.sockets.get(player.id);
      if (socket) {
        socket.emit('puzzle', {
          room: state.currentRoom,
          puzzle: state.currentPuzzle,
          title: pd.title,
          desc: pd.desc,
          visual: pd.visual,
          clues: pd.perPlayer[index] || pd.perPlayer[0] || [],
        });
      }
    });
  }

  function checkAnswer(answer) {
    if (!state.puzzleData) return false;
    const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, '');
    return normalize(answer) === normalize(state.puzzleData.answer);
  }

  function advancePuzzle() {
    io.emit('solved', {});
    addChat('Sistema', '#22C55E', 'Correcto! Puzzle resuelto!');

    if (state.currentPuzzle < 1) {
      // Next puzzle in same room
      state.currentPuzzle++;
      state.hintsLeft = MAX_HINTS;
      startPuzzle();
      setTimeout(() => {
        sendPuzzleToPlayers();
        broadcastState();
      }, 1500);
    } else {
      // Room complete
      io.emit('roomDone', { nextRoom: state.currentRoom + 1 });
      addChat('Sistema', '#22C55E', `Sala "${ROOMS[state.currentRoom].name}" completada!`);

      if (state.currentRoom < 2) {
        state.currentRoom++;
        state.currentPuzzle = 0;
        state.timer = ROOM_TIME;
        state.hintsLeft = MAX_HINTS;
        setTimeout(() => {
          startPuzzle();
          sendPuzzleToPlayers();
          addChat('Sistema', '#888', `Entrando a "${ROOMS[state.currentRoom].name}" ${ROOMS[state.currentRoom].emoji}`);
          broadcastState();
        }, 2500);
      } else {
        // WIN
        state.phase = 'ended';
        io.emit('win', {});
        stopTimer();
      }
    }
  }

  // ─── Timer ────────────────────────────────────────────────────────

  let timerInterval = null;

  function startTimer() {
    stopTimer();
    timerInterval = setInterval(() => {
      if (state.phase !== 'playing') return;
      state.timer--;
      if (state.timer <= 0) {
        state.phase = 'ended';
        io.emit('lose', {});
        stopTimer();
      }
      broadcastState();
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function broadcastState() {
    io.emit('state', {
      phase: state.phase,
      timer: state.timer,
      room: state.currentRoom,
      puzzle: state.currentPuzzle,
      hints: state.hintsLeft,
      roomName: ROOMS[state.currentRoom] ? ROOMS[state.currentRoom].name : '',
      roomEmoji: ROOMS[state.currentRoom] ? ROOMS[state.currentRoom].emoji : '',
      roomColor: ROOMS[state.currentRoom] ? ROOMS[state.currentRoom].color : '#C084FC',
      puzzleName: PUZZLE_NAMES[state.currentRoom] ? PUZZLE_NAMES[state.currentRoom][state.currentPuzzle] : '',
    });
  }

  function addChat(name, color, msg) {
    state.chat.push({ name, color, msg, time: Date.now() });
    if (state.chat.length > MAX_CHAT) state.chat.shift();
    io.emit('chat', { name, color, msg });
  }

  // ─── Socket Handling ──────────────────────────────────────────────

  io.on('connection', (socket) => {
    // Send lobby state
    socket.emit('lobby', {
      players: state.players.map(p => ({ name: p.name, color: p.color })),
    });
    broadcastState();

    socket.on('join', (data) => {
      if (state.phase !== 'lobby') {
        socket.emit('error', { msg: 'La partida ya comenzo' });
        return;
      }
      if (state.players.length >= 4) {
        socket.emit('error', { msg: 'Sala llena (maximo 4 jugadores)' });
        return;
      }
      if (state.players.find(p => p.id === socket.id)) {
        socket.emit('error', { msg: 'Ya estas en la sala' });
        return;
      }
      const name = (data && data.name ? data.name : 'Jugador').slice(0, 20);
      const color = PLAYER_COLORS[state.players.length];
      state.players.push({ id: socket.id, name, color });
      addChat('Sistema', '#888', `${name} se unio a la sala`);
      io.emit('lobby', {
        players: state.players.map(p => ({ name: p.name, color: p.color })),
      });
      broadcastState();
    });

    socket.on('start', () => {
      if (state.phase !== 'lobby') return;
      if (state.players.length < 1) {
        socket.emit('error', { msg: 'Se necesita al menos 1 jugador' });
        return;
      }
      state.phase = 'playing';
      state.currentRoom = 0;
      state.currentPuzzle = 0;
      state.timer = ROOM_TIME;
      state.hintsLeft = MAX_HINTS;
      io.emit('gameStart', {});
      startPuzzle();
      setTimeout(() => {
        sendPuzzleToPlayers();
        broadcastState();
        startTimer();
        addChat('Sistema', '#888', `Bienvenidos a "${ROOMS[0].name}" ${ROOMS[0].emoji}`);
      }, 500);
    });

    socket.on('chat', (data) => {
      const player = state.players.find(p => p.id === socket.id);
      if (!player) return;
      const msg = data && data.msg ? String(data.msg).slice(0, 300) : '';
      if (!msg) return;
      addChat(player.name, player.color, msg);
    });

    socket.on('answer', (data) => {
      if (state.phase !== 'playing') return;
      const player = state.players.find(p => p.id === socket.id);
      if (!player) return;
      const answer = data && data.answer ? String(data.answer) : '';
      if (!answer) return;

      if (checkAnswer(answer)) {
        advancePuzzle();
        broadcastState();
      } else {
        socket.emit('wrong', { msg: 'Incorrecto! Sigan intentando...' });
        addChat('Sistema', '#EF4444', `${player.name} intento una respuesta incorrecta`);
      }
    });

    socket.on('hint', () => {
      if (state.phase !== 'playing') return;
      if (state.hintsLeft <= 0) {
        socket.emit('error', { msg: 'No quedan pistas' });
        return;
      }
      if (!state.puzzleData || !state.puzzleData.hint) return;
      state.hintsLeft--;
      state.timer = Math.max(0, state.timer - HINT_PENALTY);
      io.emit('hint', { text: state.puzzleData.hint });
      addChat('Sistema', '#F59E0B', `💡 PISTA: ${state.puzzleData.hint} (-${HINT_PENALTY}s)`);
      broadcastState();
    });

    socket.on('restart', () => {
      stopTimer();
      state = resetState();
      io.emit('lobby', { players: [] });
      broadcastState();
    });

    socket.on('disconnect', () => {
      const idx = state.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const name = state.players[idx].name;
        state.players.splice(idx, 1);
        addChat('Sistema', '#888', `${name} se desconecto`);
        if (state.players.length === 0 && state.phase === 'playing') {
          stopTimer();
          state = resetState();
        }
        io.emit('lobby', {
          players: state.players.map(p => ({ name: p.name, color: p.color })),
        });
        broadcastState();
      }
    });
  });
};
