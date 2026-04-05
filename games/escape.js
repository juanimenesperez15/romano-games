module.exports = function (io) {
  const PLAYER_COLORS = ['#EF4444', '#3B82F6', '#22C55E', '#F59E0B'];
  const ROOM_TIME = 300; // 5 minutes
  const HINT_PENALTY = 15;
  const MAX_HINTS = 3;
  const MAX_CHAT = 50;

  const ROOMS = ['Laboratorio', 'Mansion', 'Piramide'];
  const PUZZLES = [
    ['Codigo', 'Colores', 'Secuencia'],
    ['Combinacion', 'Fantasmas', 'Llave'],
    ['Jeroglificos', 'Trampa', 'Tesoro'],
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
      hintPenalty: 0,
      chat: [],
      puzzleData: null,
      roomTimes: [],
      totalTime: 0,
    };
  }

  // ─── Puzzle generators ───────────────────────────────────────────────

  function generatePuzzle(room, puzzle, playerCount) {
    if (room === 0 && puzzle === 0) return genCodigo(playerCount);
    if (room === 0 && puzzle === 1) return genColores(playerCount);
    if (room === 0 && puzzle === 2) return genSecuencia(playerCount);
    if (room === 1 && puzzle === 0) return genCombinacion(playerCount);
    if (room === 1 && puzzle === 1) return genFantasmas(playerCount);
    if (room === 1 && puzzle === 2) return genLlave(playerCount);
    if (room === 2 && puzzle === 0) return genJeroglificos(playerCount);
    if (room === 2 && puzzle === 1) return genTrampa(playerCount);
    if (room === 2 && puzzle === 2) return genTesoro(playerCount);
  }

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

  function distribute(items, playerCount) {
    const buckets = Array.from({ length: playerCount }, () => []);
    items.forEach((item, i) => buckets[i % playerCount].push(item));
    return buckets;
  }

  // Room 1 Puzzle 1: Codigo - 4 digit code
  function genCodigo(playerCount) {
    const digits = [randInt(0, 9), randInt(0, 9), randInt(0, 9), randInt(0, 9)];
    const answer = digits.join('');
    const clues = [
      `La posicion 1 es ${digits[0]}`,
      `La posicion 2 es ${digits[1]}`,
      `La posicion 3 es ${digits[2]}`,
      `La posicion 4 es ${digits[3]}`,
    ];
    const perPlayer = distribute(clues, playerCount);
    return {
      answer,
      description: 'Un panel pide un codigo de 4 digitos. Cada uno tiene pistas parciales.',
      perPlayer,
      hint: `El primer digito es ${digits[0]}`,
    };
  }

  // Room 1 Puzzle 2: Colores - wire order
  function genColores(playerCount) {
    const colors = shuffle(['Rojo', 'Azul', 'Verde', 'Amarillo']);
    const answer = colors.join(',');
    const clues = [];
    clues.push(`${colors[0]} va en la posicion 1`);
    clues.push(`${colors[3]} va en la posicion 4`);
    // negative clues for middle positions
    const wrong2 = colors.filter((c) => c !== colors[1]);
    const wrong3 = colors.filter((c) => c !== colors[2]);
    clues.push(`${wrong2[0]} NO va en la posicion 2`);
    clues.push(`${wrong3[1]} NO va en la posicion 3`);
    clues.push(`${colors[1]} va antes que ${colors[2]}`);
    clues.push(`${colors[2]} NO va en la posicion 1`);
    const perPlayer = distribute(clues, playerCount);
    return {
      answer,
      description:
        'Hay 4 cables de colores (Rojo, Azul, Verde, Amarillo). Deben conectarse en el orden correcto. Responde con los colores separados por coma.',
      perPlayer,
      hint: `El primer cable es ${colors[0]}`,
    };
  }

  // Room 1 Puzzle 3: Secuencia - 6 symbols
  function genSecuencia(playerCount) {
    const allSymbols = ['★', '▲', '●', '■', '◆', '♥', '♣', '⬟', '✦', '⬡'];
    const chosen = shuffle(allSymbols).slice(0, 6);
    const answer = chosen.join(',');
    const clues = chosen.map((s, i) => `Posicion ${i + 1}: ${s}`);
    const perPlayer = distribute(clues, playerCount);
    return {
      answer,
      description:
        'Una secuencia de 6 simbolos aparece en la pared. Cada uno ve algunos. Reconstruyan el orden. Responde con los simbolos separados por coma.',
      perPlayer,
      hint: `El primer simbolo es ${chosen[0]}`,
    };
  }

  // Room 2 Puzzle 1: Combinacion - 3 numbers
  function genCombinacion(playerCount) {
    const nums = [randInt(1, 50), randInt(1, 50), randInt(1, 50)];
    const answer = nums.join(',');
    const clueTexts = [
      `Un cuadro muestra numeros romanos: el primero es ${toRoman(nums[0])}`,
      `El reloj de pared marca las ${nums[1]} (minutos)`,
      `Un libro abierto en la pagina ${nums[2]}`,
    ];
    const perPlayer = distribute(clueTexts, playerCount);
    return {
      answer,
      description:
        'Una caja fuerte necesita 3 numeros. Las pistas estan repartidas. Responde con los 3 numeros separados por coma.',
      perPlayer,
      hint: `El primer numero es ${nums[0]}`,
    };
  }

  function toRoman(num) {
    const vals = [50, 40, 10, 9, 5, 4, 1];
    const syms = ['L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
    let result = '';
    for (let i = 0; i < vals.length; i++) {
      while (num >= vals[i]) {
        result += syms[i];
        num -= vals[i];
      }
    }
    return result;
  }

  // Room 2 Puzzle 2: Fantasmas - 5 candles order
  function genFantasmas(playerCount) {
    const order = shuffle([1, 2, 3, 4, 5]);
    const answer = order.join(',');
    const clues = order.map((pos, i) => `La vela ${pos} se enciende en posicion ${i + 1}`);
    const perPlayer = distribute(clues, playerCount);
    return {
      answer,
      description:
        'Hay 5 velas numeradas (1-5). Deben encenderse en el orden correcto para ahuyentar a los fantasmas. Responde con los numeros de vela en orden, separados por coma.',
      perPlayer,
      hint: `La primera vela a encender es la ${order[0]}`,
    };
  }

  // Room 2 Puzzle 3: Llave - 4 keys to 4 locks
  function genLlave(playerCount) {
    const keys = ['Dorada', 'Plateada', 'Bronce', 'Hierro'];
    const locks = ['Puerta', 'Cofre', 'Cajon', 'Armario'];
    const mapping = shuffle([0, 1, 2, 3]); // key i -> lock mapping[i]
    const answer = keys.map((k, i) => `${k}-${locks[mapping[i]]}`).join(',');
    const clues = [];
    for (let i = 0; i < 4; i++) {
      const wrongLocks = [0, 1, 2, 3].filter((l) => l !== mapping[i]);
      const wrongLock = wrongLocks[randInt(0, wrongLocks.length - 1)];
      clues.push(`La llave ${keys[i]} NO abre ${locks[wrongLock]}`);
    }
    // Add positive clues for solvability
    const reveal = randInt(0, 3);
    clues.push(`La llave ${keys[reveal]} abre ${locks[mapping[reveal]]}`);
    clues.push(
      `La llave ${keys[(reveal + 2) % 4]} abre ${locks[mapping[(reveal + 2) % 4]]}`
    );
    const perPlayer = distribute(clues, playerCount);
    return {
      answer,
      description:
        'Hay 4 llaves (Dorada, Plateada, Bronce, Hierro) y 4 cerraduras (Puerta, Cofre, Cajon, Armario). Responde: Llave-Cerradura separadas por coma. Ej: Dorada-Puerta,Plateada-Cofre,...',
      perPlayer,
      hint: `La llave ${keys[reveal]} abre ${locks[mapping[reveal]]}`,
    };
  }

  // Room 3 Puzzle 1: Jeroglificos - match 4 symbols to 4 meanings
  function genJeroglificos(playerCount) {
    const symbols = ['𓂀', '𓃭', '𓆣', '𓇳'];
    const meanings = ['Agua', 'Fuego', 'Tierra', 'Aire'];
    const mapping = shuffle([0, 1, 2, 3]);
    const answer = symbols.map((s, i) => `${s}-${meanings[mapping[i]]}`).join(',');
    const clues = symbols.map(
      (s, i) => `El simbolo ${s} significa "${meanings[mapping[i]]}"`
    );
    // Add a red herring negative clue
    const wrong = (mapping[0] + 1) % 4;
    clues.push(`El simbolo ${symbols[0]} NO significa "${meanings[wrong]}"`);
    const perPlayer = distribute(clues, playerCount);
    return {
      answer,
      description:
        'Hay 4 jeroglificos en la pared. Cada uno representa un elemento. Responde: simbolo-significado separados por coma.',
      perPlayer,
      hint: `${symbols[0]} significa "${meanings[mapping[0]]}"`,
    };
  }

  // Room 3 Puzzle 2: Trampa - 4x4 grid safe path
  function genTrampa(playerCount) {
    // Generate a safe path from top-left to bottom-right
    const grid = Array.from({ length: 4 }, () => Array(4).fill(false));
    // Create a guaranteed path
    let path = [];
    let x = 0,
      y = 0;
    path.push([0, 0]);
    grid[0][0] = true;
    while (x < 3 || y < 3) {
      if (x === 3) {
        y++;
      } else if (y === 3) {
        x++;
      } else {
        Math.random() < 0.5 ? x++ : y++;
      }
      grid[y][x] = true;
      path.push([x, y]);
    }
    // Add a few extra safe tiles
    for (let i = 0; i < 3; i++) {
      const rx = randInt(0, 3);
      const ry = randInt(0, 3);
      grid[ry][rx] = true;
    }
    const safeTiles = [];
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++) if (grid[r][c]) safeTiles.push(`${c},${r}`);

    // Answer is the path coordinates
    const answer = path.map((p) => `${p[0]},${p[1]}`).join(';');
    const clues = distribute(
      safeTiles.map((t) => `La casilla (${t}) es segura`),
      playerCount
    );
    return {
      answer,
      validate: (input) => {
        // Accept if all steps are on safe tiles and form a valid adjacent path
        const steps = input.split(';').map((s) => s.split(',').map(Number));
        if (steps[0][0] !== 0 || steps[0][1] !== 0) return false;
        if (steps[steps.length - 1][0] !== 3 || steps[steps.length - 1][1] !== 3)
          return false;
        for (let i = 0; i < steps.length; i++) {
          const [sx, sy] = steps[i];
          if (!grid[sy] || !grid[sy][sx]) return false;
          if (i > 0) {
            const [px, py] = steps[i - 1];
            const dist = Math.abs(sx - px) + Math.abs(sy - py);
            if (dist !== 1) return false;
          }
        }
        return true;
      },
      description:
        'Una cuadricula 4x4 tiene trampas ocultas. Deben encontrar un camino seguro de (0,0) a (3,3). Cada uno ve distintas casillas seguras. Responde con el camino: x,y;x,y;... (movimientos adyacentes).',
      perPlayer: clues,
      hint: `La casilla (${path[1][0]},${path[1][1]}) es el segundo paso seguro`,
    };
  }

  // Room 3 Puzzle 3: Tesoro - final combination
  function genTesoro(playerCount) {
    const finalCode = [randInt(1, 9), randInt(1, 9), randInt(1, 9), randInt(1, 9)];
    const answer = finalCode.join('');
    const clues = [
      `Recuerda el laboratorio: la suma de los dos primeros digitos es ${finalCode[0] + finalCode[1]}`,
      `El tercer digito es impar: ${finalCode[2]}`,
      `El ultimo digito es ${finalCode[3]}`,
      `El primer digito es mayor que ${finalCode[0] - 1}`,
      `El segundo digito es ${finalCode[1]}`,
    ];
    const perPlayer = distribute(clues, playerCount);
    return {
      answer,
      description:
        'El cofre del tesoro necesita un codigo final de 4 digitos. Las ultimas pistas estan repartidas entre todos. Responde con los 4 digitos.',
      perPlayer,
      hint: `Los dos primeros digitos son ${finalCode[0]} y ${finalCode[1]}`,
    };
  }

  // ─── Game logic ──────────────────────────────────────────────────────

  function startPuzzle() {
    const pc = state.players.length;
    state.puzzleData = generatePuzzle(state.currentRoom, state.currentPuzzle, pc);
  }

  function sendPuzzleToPlayers() {
    if (!state.puzzleData) return;
    state.players.forEach((player, index) => {
      const socket = io.sockets.get(player.id);
      if (socket) {
        socket.emit('puzzle', {
          room: ROOMS[state.currentRoom],
          puzzleName: PUZZLES[state.currentRoom][state.currentPuzzle],
          puzzleIndex: state.currentPuzzle,
          description: state.puzzleData.description,
          clues: state.puzzleData.perPlayer[index] || [],
        });
      }
    });
  }

  function checkAnswer(answer) {
    if (!state.puzzleData) return false;
    if (state.puzzleData.validate) {
      return state.puzzleData.validate(answer);
    }
    // Normalize: trim, lowercase, remove spaces
    const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, '');
    return normalize(answer) === normalize(state.puzzleData.answer);
  }

  function advancePuzzle() {
    if (state.currentPuzzle < 2) {
      state.currentPuzzle++;
      state.hintsLeft = MAX_HINTS;
      startPuzzle();
      sendPuzzleToPlayers();
      io.emit('solved', {
        puzzle: PUZZLES[state.currentRoom][state.currentPuzzle - 1],
      });
    } else {
      // Room complete
      const timeUsed = ROOM_TIME - state.timer + state.hintPenalty;
      state.roomTimes.push(timeUsed);
      io.emit('roomComplete', {
        room: ROOMS[state.currentRoom],
        timeLeft: state.timer,
      });
      if (state.currentRoom < 2) {
        state.currentRoom++;
        state.currentPuzzle = 0;
        state.timer = ROOM_TIME;
        state.hintsLeft = MAX_HINTS;
        state.hintPenalty = 0;
        startPuzzle();
        sendPuzzleToPlayers();
      } else {
        // Game won!
        state.totalTime = state.roomTimes.reduce((a, b) => a + b, 0);
        state.phase = 'solved';
        io.emit('gameOver', { win: true, totalTime: state.totalTime, roomTimes: state.roomTimes });
        stopTimer();
      }
    }
  }

  // ─── Timer ───────────────────────────────────────────────────────────

  let timerInterval = null;

  function startTimer() {
    stopTimer();
    timerInterval = setInterval(() => {
      if (state.phase !== 'playing') return;
      state.timer--;
      if (state.timer <= 0) {
        state.phase = 'failed';
        io.emit('gameOver', {
          win: false,
          room: ROOMS[state.currentRoom],
          puzzle: PUZZLES[state.currentRoom][state.currentPuzzle],
        });
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
      players: state.players.map((p) => ({ name: p.name, color: p.color })),
      currentRoom: state.currentRoom,
      currentRoomName: ROOMS[state.currentRoom],
      currentPuzzle: state.currentPuzzle,
      currentPuzzleName: PUZZLES[state.currentRoom]
        ? PUZZLES[state.currentRoom][state.currentPuzzle]
        : null,
      timer: state.timer,
      hintsLeft: state.hintsLeft,
      roomTimes: state.roomTimes,
    });
  }

  function addChat(name, color, msg) {
    state.chat.push({ name, color, msg, time: Date.now() });
    if (state.chat.length > MAX_CHAT) state.chat.shift();
    io.emit('chat', { name, color, msg });
  }

  // ─── Socket handling ─────────────────────────────────────────────────

  io.on('connection', (socket) => {
    // Send current state on connect
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
      if (state.players.find((p) => p.id === socket.id)) {
        socket.emit('error', { msg: 'Ya estas en la sala' });
        return;
      }
      const name = (data && data.name ? data.name : 'Jugador').slice(0, 20);
      const color = PLAYER_COLORS[state.players.length];
      state.players.push({ id: socket.id, name, color });
      addChat('Sistema', '#888888', `${name} se unio a la sala`);
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
      state.hintPenalty = 0;
      state.roomTimes = [];
      startPuzzle();
      sendPuzzleToPlayers();
      startTimer();
      addChat('Sistema', '#888888', 'La partida ha comenzado! Sala: Laboratorio');
      broadcastState();
    });

    socket.on('chat', (data) => {
      const player = state.players.find((p) => p.id === socket.id);
      if (!player) return;
      const msg = data && data.msg ? String(data.msg).slice(0, 300) : '';
      if (!msg) return;
      addChat(player.name, player.color, msg);
    });

    socket.on('answer', (data) => {
      if (state.phase !== 'playing') return;
      const player = state.players.find((p) => p.id === socket.id);
      if (!player) return;
      const answer = data && data.answer ? String(data.answer) : '';
      if (!answer) return;

      addChat(player.name, player.color, `[Respuesta] ${answer}`);

      if (checkAnswer(answer)) {
        addChat('Sistema', '#22C55E', 'Correcto! Puzzle resuelto!');
        advancePuzzle();
        broadcastState();
      } else {
        socket.emit('wrong', { msg: 'Respuesta incorrecta, sigan intentando!' });
        addChat('Sistema', '#EF4444', 'Respuesta incorrecta...');
      }
    });

    socket.on('hint', () => {
      if (state.phase !== 'playing') return;
      if (state.hintsLeft <= 0) {
        socket.emit('error', { msg: 'No quedan pistas para esta sala' });
        return;
      }
      if (!state.puzzleData || !state.puzzleData.hint) return;
      state.hintsLeft--;
      state.hintPenalty += HINT_PENALTY;
      state.timer = Math.max(0, state.timer - HINT_PENALTY);
      const hintText = state.puzzleData.hint;
      io.emit('hint', { text: hintText, hintsLeft: state.hintsLeft });
      addChat('Sistema', '#F59E0B', `Pista: ${hintText} (-${HINT_PENALTY}s)`);
      broadcastState();
    });

    socket.on('restart', () => {
      stopTimer();
      state = resetState();
      broadcastState();
    });

    socket.on('disconnect', () => {
      const idx = state.players.findIndex((p) => p.id === socket.id);
      if (idx !== -1) {
        const name = state.players[idx].name;
        state.players.splice(idx, 1);
        addChat('Sistema', '#888888', `${name} se desconecto`);
        if (state.players.length === 0 && state.phase === 'playing') {
          stopTimer();
          state = resetState();
        }
        broadcastState();
      }
    });
  });
};
