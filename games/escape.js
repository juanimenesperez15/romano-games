module.exports = function (io) {
  var PLAYER_COLORS = ['#EF4444', '#3B82F6', '#22C55E', '#F59E0B'];
  var ROOM_TIME = 300; // 5 minutes per room
  var MAX_HINTS = 3;
  var HINT_PENALTY = 30;
  var MAX_CHAT = 100;
  var TICK_RATE = 33; // ~30fps
  var INTERACT_DIST = 60;
  var PLAYER_SPEED = 3;
  var PLAYER_RADIUS = 14;

  // ─── Room Definitions ───────────────────────────────────────────

  function generateRoom1() {
    // Book numbers are randomized
    var bookNums = {};
    var digits = shuffle([0,1,2,3,4,5,6,7,8,9]);
    bookNums.red = digits[0];
    bookNums.blue = digits[1];
    bookNums.green = digits[2];
    bookNums.yellow = digits[3];
    // Order: blue, green, yellow, red (cielo, hierba, sol, sangre)
    var answer = '' + bookNums.blue + bookNums.green + bookNums.yellow + bookNums.red;

    return {
      name: 'La Oficina',
      emoji: '🏢',
      width: 600,
      height: 400,
      answer: answer,
      answerType: 'keypad4',
      puzzleObjectId: 'door',
      objects: [
        {
          id: 'desk', type: 'furniture', x: 120, y: 280, w: 80, h: 50,
          label: 'Escritorio', icon: '🗃️',
          clue: { title: 'Nota en el escritorio', content: '"El codigo esta escondido en los libros"', type: 'text' },
          visibleTo: 'all'
        },
        {
          id: 'bookshelf', type: 'furniture', x: 350, y: 50, w: 100, h: 50,
          label: 'Estanteria', icon: '📚',
          clue: {
            title: 'Estanteria de libros',
            content: '4 libros de colores con numeros en el lomo:\n🔴 Rojo = ' + bookNums.red + '\n🔵 Azul = ' + bookNums.blue + '\n🟢 Verde = ' + bookNums.green + '\n🟡 Amarillo = ' + bookNums.yellow,
            type: 'text'
          },
          visibleTo: 'split-a'
        },
        {
          id: 'painting', type: 'decoration', x: 80, y: 50, w: 70, h: 55,
          label: 'Pintura', icon: '🖼️',
          clue: {
            title: 'Detras de la pintura',
            content: 'Un mensaje oculto:\n"El orden es: el color del cielo, la hierba, el sol, la sangre"',
            type: 'text'
          },
          visibleTo: 'split-b'
        },
        {
          id: 'door', type: 'puzzle', x: 530, y: 160, w: 50, h: 80,
          label: 'Puerta', icon: '🚪',
          clue: { title: 'Puerta cerrada', content: 'Necesitas un codigo de 4 digitos para abrir esta puerta.', type: 'keypad4' },
          visibleTo: 'all'
        },
        {
          id: 'plant', type: 'decoration', x: 470, y: 310, w: 40, h: 45,
          label: 'Maceta', icon: '🪴',
          clue: { title: 'Maceta', content: 'Solo tierra... nada util aqui.', type: 'text' },
          visibleTo: 'all'
        },
        {
          id: 'clock', type: 'decoration', x: 260, y: 50, w: 40, h: 40,
          label: 'Reloj', icon: '🕐',
          clue: { title: 'Reloj de pared', content: 'Marca las 3:47. No parece tener significado especial.', type: 'text' },
          visibleTo: 'all'
        }
      ],
      hints: [
        'La pintura habla de colores del cielo, hierba, sol y sangre...',
        'Cielo=azul, hierba=verde, sol=amarillo, sangre=rojo. Busca los numeros de los libros en ese orden.',
        'El codigo es: Azul, Verde, Amarillo, Rojo → ' + answer
      ]
    };
  }

  function generateRoom2() {
    // Beaker order: triangle=B, circle=A, so square=C → answer is BAC
    var answer = 'BAC';
    return {
      name: 'El Laboratorio',
      emoji: '🧪',
      width: 600,
      height: 400,
      answer: answer,
      answerType: 'beakers',
      puzzleObjectId: 'cabinet',
      objects: [
        {
          id: 'whiteboard', type: 'furniture', x: 200, y: 45, w: 120, h: 55,
          label: 'Pizarra', icon: '📋',
          clue: {
            title: 'Pizarra',
            content: 'Una formula quimica:\n△ + ○ = □\n"Mezcla los ingredientes en orden"',
            type: 'text'
          },
          visibleTo: 'all'
        },
        {
          id: 'beakers', type: 'furniture', x: 100, y: 200, w: 90, h: 50,
          label: 'Vasos de precipitado', icon: '🧫',
          clue: {
            title: 'Vasos A, B y C',
            content: 'Tres vasos de precipitado etiquetados A, B y C.\nCada uno contiene un liquido de diferente color.\nDeben ir en el gabinete en el orden correcto.',
            type: 'text'
          },
          visibleTo: 'all'
        },
        {
          id: 'microscope', type: 'furniture', x: 400, y: 120, w: 50, h: 55,
          label: 'Microscopio', icon: '🔬',
          clue: {
            title: 'Microscopio',
            content: 'Mirando por el lente se ve una etiqueta:\n"△ = Vaso B"',
            type: 'text'
          },
          visibleTo: 'split-a'
        },
        {
          id: 'notebook', type: 'furniture', x: 300, y: 310, w: 45, h: 40,
          label: 'Cuaderno', icon: '📓',
          clue: {
            title: 'Cuaderno en el piso',
            content: 'Un cuaderno abierto en el piso:\n"○ = Vaso A"',
            type: 'text'
          },
          visibleTo: 'split-b'
        },
        {
          id: 'cabinet', type: 'puzzle', x: 500, y: 160, w: 60, h: 80,
          label: 'Gabinete', icon: '🗄️',
          clue: { title: 'Gabinete cerrado', content: 'Tiene 3 ranuras para vasos. Ingresa el orden correcto (ej: ABC).', type: 'beakers' },
          visibleTo: 'all'
        },
        {
          id: 'fridge', type: 'decoration', x: 50, y: 80, w: 45, h: 60,
          label: 'Refrigerador', icon: '🧊',
          clue: { title: 'Refrigerador', content: 'Vacio... hace frio.', type: 'text' },
          visibleTo: 'all'
        },
        {
          id: 'poster', type: 'decoration', x: 450, y: 45, w: 55, h: 50,
          label: 'Poster', icon: '🧬',
          clue: { title: 'Poster', content: 'Una tabla periodica borrosa. No se puede leer nada util.', type: 'text' },
          visibleTo: 'all'
        }
      ],
      hints: [
        'La pizarra muestra: △ + ○ = □. Necesitas saber que vaso es cada simbolo.',
        'El microscopio dice △=B, el cuaderno dice ○=A. Si △=B y ○=A, entonces □ debe ser C.',
        'El orden es B, A, C → ' + answer
      ]
    };
  }

  function generateRoom3() {
    // Mirror shows "824" reversed → actual is 428. Add 5 to each: 4+5=9, 2+5=7, 8+5=13→3
    // So answer is 973
    var answer = '973';
    return {
      name: 'La Boveda',
      emoji: '🏦',
      width: 600,
      height: 400,
      answer: answer,
      answerType: 'safe',
      puzzleObjectId: 'safe',
      objects: [
        {
          id: 'safe', type: 'puzzle', x: 280, y: 60, w: 60, h: 60,
          label: 'Caja fuerte', icon: '🔐',
          clue: { title: 'Caja fuerte', content: 'Tiene una cerradura de combinacion de 3 numeros (cada uno 0-9).', type: 'safe' },
          visibleTo: 'all'
        },
        {
          id: 'mirror', type: 'furniture', x: 80, y: 80, w: 55, h: 65,
          label: 'Espejo', icon: '🪞',
          clue: {
            title: 'Espejo en la pared',
            content: 'El espejo refleja unos numeros escritos en la pared opuesta.\nVes: "4  2  8"\n(Recuerda: en un espejo todo se ve invertido...)',
            type: 'text'
          },
          visibleTo: 'split-a'
        },
        {
          id: 'statue1', type: 'decoration', x: 450, y: 100, w: 40, h: 55,
          label: 'Estatua 1', icon: '🗿',
          clue: { title: 'Estatua con placa', content: 'La placa dice: "IX" (9 en romano).', type: 'text' },
          visibleTo: 'all'
        },
        {
          id: 'statue2', type: 'decoration', x: 450, y: 200, w: 40, h: 55,
          label: 'Estatua 2', icon: '🗿',
          clue: { title: 'Estatua con placa', content: 'La placa dice: "VII" (7 en romano).', type: 'text' },
          visibleTo: 'all'
        },
        {
          id: 'statue3', type: 'decoration', x: 450, y: 300, w: 40, h: 55,
          label: 'Estatua 3', icon: '🗿',
          clue: { title: 'Estatua boca abajo', content: 'La placa esta boca abajo. La volteas y dice: "III" (3 en romano).', type: 'text' },
          visibleTo: 'all'
        },
        {
          id: 'floortile', type: 'furniture', x: 200, y: 300, w: 55, h: 40,
          label: 'Baldosa suelta', icon: '🧱',
          clue: {
            title: 'Nota bajo la baldosa',
            content: 'Una nota arrugada:\n"Suma 5 a cada numero del espejo"',
            type: 'text'
          },
          visibleTo: 'split-b'
        },
        {
          id: 'laser', type: 'decoration', x: 530, y: 160, w: 50, h: 80,
          label: 'Rejilla laser', icon: '⚡',
          clue: { title: 'Rejilla laser', content: 'Rayos laser bloquean la salida. Se desactivaran al abrir la caja fuerte.', type: 'text' },
          visibleTo: 'all'
        },
        {
          id: 'monitor', type: 'decoration', x: 100, y: 240, w: 50, h: 40,
          label: 'Monitor', icon: '🖥️',
          clue: { title: 'Monitor de seguridad', content: 'Muestra imagenes de camaras de seguridad. Solo estatica.', type: 'text' },
          visibleTo: 'all'
        },
        {
          id: 'vent', type: 'decoration', x: 350, y: 45, w: 50, h: 30,
          label: 'Ventilacion', icon: '🌀',
          clue: { title: 'Rejilla de ventilacion', content: 'Demasiado pequena para pasar. Solo sale aire frio.', type: 'text' },
          visibleTo: 'all'
        }
      ],
      hints: [
        'El espejo muestra numeros... pero reflejados. Las estatuas tambien tienen numeros romanos.',
        'El espejo muestra 4,2,8. La nota dice sumar 5 a cada uno: 4+5=9, 2+5=7, 8+5=13→3.',
        'El codigo de la caja fuerte es: 9, 7, 3 → ' + answer
      ]
    };
  }

  // ─── Utilities ────────────────────────────────────────────────────

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function dist(x1, y1, x2, y2) {
    var dx = x1 - x2, dy = y1 - y2;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ─── State ────────────────────────────────────────────────────────

  var state = resetState();

  function resetState() {
    return {
      phase: 'lobby',
      players: {},       // socketId -> {id, name, color, x, y, index}
      playerOrder: [],   // socket ids in join order
      currentRoom: 0,
      timer: ROOM_TIME,
      hintsUsed: 0,
      roomData: null,    // current room object data
      discovered: {},    // objectId -> {socketId: true}
      chat: []
    };
  }

  function getPlayerCount() {
    return state.playerOrder.length;
  }

  function getPlayerIndex(socketId) {
    return state.playerOrder.indexOf(socketId);
  }

  // Decide object visibility for a player
  function canSeeObject(obj, socketId) {
    if (obj.visibleTo === 'all') return true;
    var idx = getPlayerIndex(socketId);
    var count = getPlayerCount();
    if (count <= 1) return true; // solo player sees everything
    if (obj.visibleTo === 'split-a') return idx % 2 === 0;
    if (obj.visibleTo === 'split-b') return idx % 2 === 1;
    return true;
  }

  // Can player interact with object?
  function canInteract(player, obj) {
    var cx = obj.x + obj.w / 2;
    var cy = obj.y + obj.h / 2;
    var d = dist(player.x, player.y, cx, cy);
    return d < INTERACT_DIST + Math.max(obj.w, obj.h) / 2;
  }

  // ─── Room management ─────────────────────────────────────────────

  function loadRoom(index) {
    var room;
    if (index === 0) room = generateRoom1();
    else if (index === 1) room = generateRoom2();
    else if (index === 2) room = generateRoom3();
    else return null;

    state.roomData = room;
    state.discovered = {};
    state.timer = ROOM_TIME;
    state.hintsUsed = 0;

    // Place players at starting positions
    var i = 0;
    state.playerOrder.forEach(function(sid) {
      var p = state.players[sid];
      if (p) {
        p.x = 100 + i * 60;
        p.y = room.height / 2 + (i % 2 === 0 ? -20 : 20);
        i++;
      }
    });

    return room;
  }

  // ─── Timer ────────────────────────────────────────────────────────

  var timerInterval = null;
  var tickInterval = null;

  function startTimer() {
    stopTimer();
    timerInterval = setInterval(function() {
      if (state.phase !== 'playing') return;
      state.timer--;
      if (state.timer <= 0) {
        state.phase = 'lost';
        io.emit('lose', {});
        stopTimer();
      }
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  }

  function startTick() {
    stopTick();
    tickInterval = setInterval(function() {
      if (state.phase !== 'playing') return;
      broadcastGameState();
    }, TICK_RATE);
  }

  function stopTick() {
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  }

  // ─── Broadcasting ─────────────────────────────────────────────────

  // Send objects once when entering room (per player)
  function sendObjectsToPlayer(sid) {
    if (!state.roomData) return;
    var visibleObjects = [];
    state.roomData.objects.forEach(function(obj) {
      if (canSeeObject(obj, sid)) {
        visibleObjects.push({
          id: obj.id, type: obj.type,
          x: obj.x, y: obj.y, w: obj.w, h: obj.h,
          label: obj.label, icon: obj.icon
        });
      }
    });
    io.to(sid).emit('objects', {
      objects: visibleObjects,
      roomWidth: state.roomData.width,
      roomHeight: state.roomData.height,
      roomName: state.roomData.name,
      roomEmoji: state.roomData.emoji,
      currentRoom: state.currentRoom
    });
  }

  function broadcastGameState() {
    if (!state.roomData) return;

    // Build lightweight players array (just positions)
    var players = [];
    state.playerOrder.forEach(function(sid) {
      var p = state.players[sid];
      if (p) {
        players.push({ id: sid, n: p.name, c: p.color, x: Math.round(p.x), y: Math.round(p.y) });
      }
    });

    // Send slim state to all (no objects - those are sent separately)
    io.emit('state', {
      timer: state.timer,
      hintsLeft: MAX_HINTS - state.hintsUsed,
      players: players
    });
  }

  function broadcastLobby() {
    var players = [];
    state.playerOrder.forEach(function(sid) {
      var p = state.players[sid];
      if (p) players.push({ name: p.name, color: p.color });
    });
    io.emit('lobby', { players: players, phase: state.phase });
  }

  function addChat(name, color, msg) {
    state.chat.push({ name: name, color: color, msg: msg, time: Date.now() });
    if (state.chat.length > MAX_CHAT) state.chat.shift();
    io.emit('chat', { name: name, color: color, msg: msg });
  }

  // ─── Socket Handling ──────────────────────────────────────────────

  io.on('connection', function(socket) {
    // Send current state
    broadcastLobby();

    // Send chat history
    state.chat.forEach(function(c) {
      socket.emit('chat', c);
    });

    socket.on('join', function(data) {
      if (state.phase !== 'lobby') {
        socket.emit('error', { msg: 'La partida ya comenzo' });
        return;
      }
      if (getPlayerCount() >= 4) {
        socket.emit('error', { msg: 'Sala llena (maximo 4 jugadores)' });
        return;
      }
      if (state.players[socket.id]) {
        socket.emit('error', { msg: 'Ya estas en la sala' });
        return;
      }

      var name = (data && data.name ? String(data.name) : 'Jugador').slice(0, 16);
      var colorIdx = state.playerOrder.length;
      var color = PLAYER_COLORS[colorIdx] || PLAYER_COLORS[0];

      state.players[socket.id] = {
        id: socket.id,
        name: name,
        color: color,
        index: colorIdx,
        x: 100 + colorIdx * 60,
        y: 200
      };
      state.playerOrder.push(socket.id);

      addChat('Sistema', '#888', name + ' se unio a la sala');
      broadcastLobby();
    });

    socket.on('start', function() {
      if (state.phase !== 'lobby') return;
      if (getPlayerCount() < 1) {
        socket.emit('error', { msg: 'Se necesita al menos 1 jugador' });
        return;
      }

      state.phase = 'playing';
      state.currentRoom = 0;
      var room = loadRoom(0);

      io.emit('gameStart', {
        roomName: room.name,
        roomEmoji: room.emoji,
        currentRoom: 0
      });

      addChat('Sistema', '#C084FC', 'Bienvenidos a "' + room.name + '" ' + room.emoji);
      // Send objects to each player
      state.playerOrder.forEach(function(sid) { sendObjectsToPlayer(sid); });
      startTimer();
      startTick();
    });

    socket.on('move', function(data) {
      if (state.phase !== 'playing') return;
      var p = state.players[socket.id];
      if (!p || !state.roomData) return;

      // Accept direct position from client (client-predicted) with server clamp
      if (data && typeof data.x === 'number' && typeof data.y === 'number') {
        p.x = clamp(data.x, PLAYER_RADIUS + 20, state.roomData.width - PLAYER_RADIUS - 20);
        p.y = clamp(data.y, PLAYER_RADIUS + 20, state.roomData.height - PLAYER_RADIUS - 20);
      }
    });

    socket.on('interact', function(data) {
      if (state.phase !== 'playing') return;
      var p = state.players[socket.id];
      if (!p || !state.roomData) return;
      var objectId = data && data.objectId ? data.objectId : '';

      // Find object
      var obj = null;
      for (var i = 0; i < state.roomData.objects.length; i++) {
        if (state.roomData.objects[i].id === objectId) {
          obj = state.roomData.objects[i];
          break;
        }
      }
      if (!obj) return;

      // Check visibility
      if (!canSeeObject(obj, socket.id)) return;

      // Check distance
      if (!canInteract(p, obj)) {
        socket.emit('tooFar', { objectId: objectId });
        return;
      }

      // Mark discovered
      if (!state.discovered[objectId]) state.discovered[objectId] = {};
      state.discovered[objectId][socket.id] = true;

      // Send clue to this player only
      socket.emit('clue', {
        objectId: objectId,
        title: obj.clue.title,
        content: obj.clue.content,
        type: obj.clue.type
      });
    });

    socket.on('answer', function(data) {
      if (state.phase !== 'playing') return;
      var p = state.players[socket.id];
      if (!p || !state.roomData) return;
      var answer = data && data.answer ? String(data.answer).trim().toUpperCase() : '';
      var expected = state.roomData.answer.toUpperCase();

      if (answer === expected) {
        // Solved!
        addChat('Sistema', '#22C55E', p.name + ' resolvio el puzzle! Sala completada!');
        io.emit('roomSolved', { room: state.currentRoom, solver: p.name });

        if (state.currentRoom < 2) {
          // Next room
          state.currentRoom++;
          setTimeout(function() {
            var room = loadRoom(state.currentRoom);
            if (room) {
              io.emit('nextRoom', {
                roomName: room.name,
                roomEmoji: room.emoji,
                currentRoom: state.currentRoom
              });
              addChat('Sistema', '#C084FC', 'Entrando a "' + room.name + '" ' + room.emoji);
              state.playerOrder.forEach(function(sid) { sendObjectsToPlayer(sid); });
              startTimer();
            }
          }, 2500);
        } else {
          // WIN
          state.phase = 'won';
          stopTimer();
          stopTick();
          setTimeout(function() {
            io.emit('win', { time: ROOM_TIME * 3 - state.timer });
          }, 2000);
        }
      } else {
        socket.emit('wrong', { msg: 'Codigo incorrecto! Sigan intentando...' });
        addChat('Sistema', '#EF4444', p.name + ' ingreso un codigo incorrecto');
      }
    });

    socket.on('hint', function() {
      if (state.phase !== 'playing') return;
      if (!state.roomData) return;
      if (state.hintsUsed >= MAX_HINTS) {
        socket.emit('error', { msg: 'No quedan pistas' });
        return;
      }

      var hintText = state.roomData.hints[state.hintsUsed] || 'No hay mas pistas disponibles.';
      state.hintsUsed++;
      state.timer = Math.max(0, state.timer - HINT_PENALTY);

      io.emit('hint', { text: hintText });
      addChat('Sistema', '#F59E0B', '💡 PISTA: ' + hintText + ' (-' + HINT_PENALTY + 's)');
    });

    socket.on('chat', function(data) {
      var p = state.players[socket.id];
      if (!p) return;
      var msg = data && data.msg ? String(data.msg).slice(0, 300) : '';
      if (!msg) return;
      addChat(p.name, p.color, msg);
    });

    socket.on('restart', function() {
      stopTimer();
      stopTick();
      state = resetState();
      broadcastLobby();
    });

    socket.on('disconnect', function() {
      if (state.players[socket.id]) {
        var name = state.players[socket.id].name;
        var idx = state.playerOrder.indexOf(socket.id);
        if (idx !== -1) state.playerOrder.splice(idx, 1);
        delete state.players[socket.id];
        addChat('Sistema', '#888', name + ' se desconecto');

        if (getPlayerCount() === 0 && state.phase === 'playing') {
          stopTimer();
          stopTick();
          state = resetState();
        }
        broadcastLobby();
      }
    });
  });
};
