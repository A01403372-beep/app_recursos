const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Estado global ────────────────────────────────────────────────
const rooms = new Map();

const FICHAS_INICIO  = { verde: 8, amarillo: 5, rojo: 0 };
const BANCO_INICIO   = { verde: 20, amarillo: 15 };
const MAX_VERDE      = 14;
const MAX_AMARILLO   = 10;
const MAX_ROJO       = 20;
const EQUIPOS        = ['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon'];

// ── Helpers ──────────────────────────────────────────────────────
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) {
    s += c[Math.floor(Math.random() * c.length)];
  }
  return s;
}

function nuevoJugador(nombre, equipo) {
  return {
    nombre,
    equipo,
    fichas: { ...FICHAS_INICIO },
    puntos: 0
  };
}

function calcularResultado(room) {
  const totales = {};

  room.players.forEach((player) => {
    totales[player.equipo] =
      (totales[player.equipo] || 0) + player.puntos;
  });

  const clasificacion = Object.entries(totales)
    .map(([equipo, puntos]) => ({ equipo, puntos }))
    .sort(
      (a, b) =>
        b.puntos - a.puntos ||
        a.equipo.localeCompare(b.equipo)
    );

  const puntajeGanador = clasificacion.length
    ? clasificacion[0].puntos
    : 0;

  return {
    ganadores: clasificacion
      .filter((item) => item.puntos === puntajeGanador)
      .map((item) => item.equipo),
    puntajeGanador,
    clasificacion
  };
}

function snapshot(room) {
  const players = {};

  room.players.forEach((player, id) => {
    players[id] = {
      nombre: player.nombre,
      equipo: player.equipo,
      fichas: { ...player.fichas },
      puntos: player.puntos
    };
  });

  return {
    code: room.code,
    ronda: room.ronda,
    players,
    banco: { ...room.banco },
    facilitador: room.facilitador,
    terminado: room.terminado,
    resultadoFinal: room.resultadoFinal
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', snapshot(room));
}

function toast(room, msg, tipo = 'info') {
  io.to(room.code).emit('toast', { msg, tipo });
}

// ── Limpieza de salas vacías ─────────────────────────────────────
setInterval(() => {
  const ahora = Date.now();

  rooms.forEach((room, code) => {
    const vacia = room.players.size === 0;
    const expirada = ahora - room.creadaEn > 30 * 60 * 1000;

    if (vacia && expirada) {
      rooms.delete(code);
    }
  });
}, 10 * 60 * 1000);

// ── Socket.IO ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  function getRoom() {
    return socket.roomCode
      ? rooms.get(socket.roomCode)
      : null;
  }

  // Crear sala nueva
  socket.on('crear', ({ nombre, equipo }) => {
    nombre =
      typeof nombre === 'string'
        ? nombre.trim().slice(0, 20)
        : '';

    if (!nombre || !EQUIPOS.includes(equipo)) {
      socket.emit(
        'err',
        'Nombre y equipo válidos requeridos'
      );
      return;
    }

    let code;

    do {
      code = genCode();
    } while (rooms.has(code));

    const room = {
      code,
      ronda: 1,
      players: new Map([
        [socket.id, nuevoJugador(nombre, equipo)]
      ]),
      banco: { ...BANCO_INICIO },
      facilitador: socket.id,
      terminado: false,
      resultadoFinal: null,
      creadaEn: Date.now()
    };

    rooms.set(code, room);

    socket.join(code);
    socket.roomCode = code;

    socket.emit('joined', {
      code,
      myId: socket.id,
      state: snapshot(room)
    });

    console.log(`[+] Sala ${code} creada por ${nombre}`);
  });

  // Unirse a sala existente
  socket.on('unirse', ({ code, nombre, equipo }) => {
    nombre =
      typeof nombre === 'string'
        ? nombre.trim().slice(0, 20)
        : '';

    if (
      !nombre ||
      !EQUIPOS.includes(equipo) ||
      typeof code !== 'string'
    ) {
      socket.emit('err', 'Faltan datos válidos');
      return;
    }

    code = code.trim().toUpperCase();

    const room = rooms.get(code);

    if (!room) {
      socket.emit(
        'err',
        'Sala no encontrada. Revisa el código.'
      );
      return;
    }

    if (room.terminado) {
      socket.emit(
        'err',
        'Esta partida ya terminó. Pide al facilitador reiniciarla.'
      );
      return;
    }

    const jugadoresEnEquipo = [...room.players.values()]
      .filter((player) => player.equipo === equipo)
      .length;

    if (jugadoresEnEquipo >= 6) {
      socket.emit(
        'err',
        `El equipo ${equipo} ya tiene 6 jugadores (máximo).`
      );
      return;
    }

    room.players.set(
      socket.id,
      nuevoJugador(nombre, equipo)
    );

    socket.join(code);
    socket.roomCode = code;

    socket.emit('joined', {
      code,
      myId: socket.id,
      state: snapshot(room)
    });

    broadcast(room);

    toast(
      room,
      `${nombre} se unió al Equipo ${equipo} 👋`,
      'join'
    );

    console.log(
      `[+] ${nombre} se unió a sala ${code} (${equipo})`
    );
  });

  // Usar ficha verde: -1 verde, +1 punto
  socket.on('usar-verde', () => {
    const room = getRoom();

    if (!room || room.terminado) {
      return;
    }

    const player = room.players.get(socket.id);

    if (!player || player.fichas.verde <= 0) {
      return;
    }

    player.fichas.verde--;
    player.puntos += 1;

    broadcast(room);
  });

  // Usar ficha amarilla: -1 amarilla, +1 residuo, +3 puntos
  socket.on('usar-amarillo', () => {
    const room = getRoom();

    if (!room || room.terminado) {
      return;
    }

    const player = room.players.get(socket.id);

    if (!player || player.fichas.amarillo <= 0) {
      return;
    }

    player.fichas.amarillo--;
    player.fichas.rojo = Math.min(
      MAX_ROJO,
      player.fichas.rojo + 1
    );
    player.puntos += 3;

    broadcast(room);
  });

  // Deshacer ficha verde
  socket.on('devolver-verde', () => {
    const room = getRoom();

    if (!room || room.terminado) {
      return;
    }

    const player = room.players.get(socket.id);

    if (
      !player ||
      player.fichas.verde >= MAX_VERDE ||
      player.puntos < 1
    ) {
      return;
    }

    player.fichas.verde++;
    player.puntos = Math.max(
      0,
      player.puntos - 1
    );

    broadcast(room);
  });

  // Deshacer ficha amarilla
  socket.on('devolver-amarillo', () => {
    const room = getRoom();

    if (!room || room.terminado) {
      return;
    }

    const player = room.players.get(socket.id);

    if (
      !player ||
      player.fichas.amarillo >= MAX_AMARILLO ||
      player.puntos < 3 ||
      player.fichas.rojo <= 0
    ) {
      return;
    }

    player.fichas.amarillo++;
    player.fichas.rojo = Math.max(
      0,
      player.fichas.rojo - 1
    );
    player.puntos = Math.max(
      0,
      player.puntos - 3
    );

    broadcast(room);
  });

  // Aplicar regeneración manual en ronda 2
  socket.on('aplicar-regen', () => {
    const room = getRoom();

    if (
      !room ||
      room.terminado ||
      room.ronda !== 2 ||
      room.facilitador !== socket.id
    ) {
      return;
    }

    room.players.forEach((player) => {
      const regeneracion = Math.max(
        0,
        3 - Math.floor(player.fichas.rojo / 2)
      );

      player.fichas.verde = Math.min(
        MAX_VERDE,
        player.fichas.verde + regeneracion
      );
    });

    broadcast(room);

    toast(
      room,
      '🌱 Regeneración aplicada a todos los equipos',
      'success'
    );
  });

  // Tomar del banco común en ronda 3
  socket.on('tomar-banco', ({ tipo }) => {
    const room = getRoom();

    if (
      !room ||
      room.terminado ||
      room.ronda !== 3 ||
      !['verde', 'amarillo'].includes(tipo)
    ) {
      return;
    }

    const player = room.players.get(socket.id);

    if (!player) {
      return;
    }

    if (!room.banco[tipo] || room.banco[tipo] <= 0) {
      socket.emit('toast', {
        msg: `El banco no tiene más fichas ${tipo}`,
        tipo: 'error'
      });
      return;
    }

    room.banco[tipo]--;

    if (tipo === 'verde') {
      player.fichas.verde = Math.min(
        MAX_VERDE,
        player.fichas.verde + 1
      );
    }

    if (tipo === 'amarillo') {
      player.fichas.amarillo = Math.min(
        MAX_AMARILLO,
        player.fichas.amarillo + 1
      );
    }

    broadcast(room);

    toast(
      room,
      `${player.nombre} tomó una ficha ${tipo} del banco 🏦`,
      'info'
    );
  });

  // Avanzar a la siguiente ronda
  socket.on('sig-ronda', () => {
    const room = getRoom();

    if (
      !room ||
      room.terminado ||
      room.ronda >= 3 ||
      room.facilitador !== socket.id
    ) {
      return;
    }

    // Al entrar a ronda 2 se regeneran fichas verdes
    if (room.ronda === 1) {
      room.players.forEach((player) => {
        const regeneracion = Math.max(
          0,
          3 - Math.floor(player.fichas.rojo / 2)
        );

        player.fichas.verde = Math.min(
          MAX_VERDE,
          player.fichas.verde + regeneracion
        );
      });
    }

    room.ronda++;

    // Al entrar a ronda 3 se reinicia el banco
    if (room.ronda === 3) {
      room.banco = { ...BANCO_INICIO };
    }

    broadcast(room);

    toast(
      room,
      `🚀 ¡Ronda ${room.ronda} comenzando!`,
      'round'
    );

    console.log(
      `[>] Sala ${room.code} avanzó a ronda ${room.ronda}`
    );
  });

  // Finalizar la partida y calcular al equipo ganador
  socket.on('finalizar', () => {
    const room = getRoom();

    if (
      !room ||
      room.terminado ||
      room.ronda !== 3 ||
      room.facilitador !== socket.id
    ) {
      return;
    }

    room.terminado = true;
    room.resultadoFinal = calcularResultado(room);

    broadcast(room);

    const nombres = room.resultadoFinal.ganadores
      .map((equipo) => `Equipo ${equipo}`)
      .join(' y ');

    const esEmpate =
      room.resultadoFinal.ganadores.length > 1;

    toast(
      room,
      esEmpate
        ? `🏆 ¡Empate! ${nombres} ganan con ${room.resultadoFinal.puntajeGanador} puntos`
        : `🏆 ¡${nombres} es el ganador con ${room.resultadoFinal.puntajeGanador} puntos!`,
      'success'
    );

    console.log(
      `[✓] Sala ${room.code} finalizada: ${nombres}`
    );
  });

  // Reiniciar juego
  socket.on('reiniciar', () => {
    const room = getRoom();

    if (
      !room ||
      room.facilitador !== socket.id
    ) {
      return;
    }

    room.ronda = 1;
    room.banco = { ...BANCO_INICIO };
    room.terminado = false;
    room.resultadoFinal = null;

    room.players.forEach((player) => {
      player.fichas = { ...FICHAS_INICIO };
      player.puntos = 0;
    });

    broadcast(room);

    toast(
      room,
      '🔄 Juego reiniciado',
      'info'
    );
  });

  // Desconexión
  socket.on('disconnect', () => {
    const room = getRoom();

    if (!room) {
      return;
    }

    const player = room.players.get(socket.id);

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      return;
    }

    // Si el facilitador se desconecta, se reasigna el rol
    if (room.facilitador === socket.id) {
      room.facilitador =
        room.players.keys().next().value;

      toast(
        room,
        '⚙️ Se asignó un nuevo facilitador',
        'info'
      );
    }

    broadcast(room);

    if (player) {
      toast(
        room,
        `${player.nombre} se desconectó`,
        'info'
      );
    }
  });
});

// ── Inicio ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `✅ Reto de los Recursos corriendo en puerto ${PORT}`
  );
});
