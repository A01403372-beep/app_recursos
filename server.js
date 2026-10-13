const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const APP_VERSION = '1.1.2';

app.get('/api/version', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    version: APP_VERSION,
    commit: process.env.RENDER_GIT_COMMIT || null
  });
});

app.get('/api/qr', async (req, res) => {
  const url = typeof req.query.url === 'string' ? req.query.url.trim() : '';

  if (!/^https?:\/\//i.test(url) || url.length > 500) {
    res.status(400).send('URL invÃ¡lida');
    return;
  }

  try {
    const svg = await QRCode.toString(url, {
      type: 'svg',
      width: 280,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0f172a', light: '#ffffff' }
    });
    res.type('image/svg+xml').send(svg);
  } catch (error) {
    console.error('[QR] No fue posible generar el cÃ³digo:', error);
    res.status(500).send('No fue posible generar el QR');
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// â”€â”€ ConfiguraciÃ³n original del juego â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const rooms = new Map();
const EQUIPOS = ['Alfa', 'Beta', 'Gamma', 'Delta', 'Epsilon'];
const TOTAL_RONDAS = 6;
const FICHAS_INICIO = { verde: 8, amarillo: 5, rojo: 0 };
const BANCO_GOBIERNO = { verde: 20, amarillo: 15 };
const BANCO_CRISIS = { verde: 6, amarillo: 4 };
const MAX_VERDE = 14;
const MAX_AMARILLO = 10;
const MAX_ROJO = 20;
const MAX_JUGADORES_EQUIPO = 6;

function generarCodigo() {
  const caracteres = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let codigo = '';
  for (let i = 0; i < 5; i++) {
    codigo += caracteres[Math.floor(Math.random() * caracteres.length)];
  }
  return codigo;
}

function nuevoJugador(nombre, equipo) {
  return {
    nombre,
    equipo,
    fichas: { ...FICHAS_INICIO },
    usadas: { verde: 0, amarillo: 0 },
    puntos: 0
  };
}

function calcularResultado(room) {
  const totales = {};

  room.players.forEach((player) => {
    if (!totales[player.equipo]) {
      totales[player.equipo] = {
        equipo: player.equipo,
        puntos: 0,
        verdesUsadas: 0,
        amarillasUsadas: 0,
        residuos: 0,
        jugadores: 0
      };
    }

    const equipo = totales[player.equipo];
    equipo.puntos += player.puntos;
    equipo.verdesUsadas += player.usadas.verde;
    equipo.amarillasUsadas += player.usadas.amarillo;
    equipo.residuos += player.fichas.rojo;
    equipo.jugadores += 1;
  });

  const clasificacion = Object.values(totales).sort(
    (a, b) => b.puntos - a.puntos || a.equipo.localeCompare(b.equipo)
  );
  const puntajeGanador = clasificacion.length ? clasificacion[0].puntos : 0;

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
      usadas: { ...player.usadas },
      puntos: player.puntos
    };
  });

  return {
    code: room.code,
    ronda: room.ronda,
    players,
    banco: { ...room.banco },
    facilitador: room.facilitador,
    facilitadorNombre: room.facilitadorNombre,
    regenAplicada: { ...room.regenAplicada },
    subsidioAplicado: room.subsidioAplicado,
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

function aplicarRegeneracion(room) {
  if (![2, 6].includes(room.ronda) || room.regenAplicada[room.ronda]) {
    return false;
  }

  room.players.forEach((player) => {
    const recuperadas = Math.max(0, 3 - Math.floor(player.fichas.rojo / 2));
    player.fichas.verde = Math.min(MAX_VERDE, player.fichas.verde + recuperadas);
  });

  room.regenAplicada[room.ronda] = true;
  return true;
}

function configurarRonda(room) {
  if (room.ronda === 2 || room.ronda === 6) {
    aplicarRegeneracion(room);
  }

  if (room.ronda === 3) {
    room.banco = { ...BANCO_GOBIERNO };
    room.subsidioAplicado = false;
  }

  if (room.ronda === 5) {
    room.banco = { ...BANCO_CRISIS };
  }
}

// Elimina salas que llevan 30 minutos vacÃ­as.
setInterval(() => {
  const ahora = Date.now();
  rooms.forEach((room, code) => {
    if (room.players.size === 0 && ahora - room.creadaEn > 30 * 60 * 1000) {
      rooms.delete(code);
    }
  });
}, 10 * 60 * 1000);

io.on('connection', (socket) => {
  function getRoom() {
    return socket.roomCode ? rooms.get(socket.roomCode) : null;
  }

  function getPlayer(room) {
    return room ? room.players.get(socket.id) : null;
  }

  function esFacilitador(room) {
    return Boolean(room && room.facilitador === socket.id);
  }

  socket.on('crear', ({ nombre } = {}) => {
    nombre = typeof nombre === 'string' ? nombre.trim().slice(0, 20) : '';

    if (!nombre) {
      socket.emit('err', 'El nombre del facilitador es requerido.');
      return;
    }

    let code;
    do {
      code = generarCodigo();
    } while (rooms.has(code));

    const room = {
      code,
      ronda: 1,
      players: new Map(),
      banco: { ...BANCO_GOBIERNO },
      facilitador: socket.id,
      facilitadorNombre: nombre,
      regenAplicada: { 2: false, 6: false },
      subsidioAplicado: false,
      terminado: false,
      resultadoFinal: null,
      creadaEn: Date.now()
    };

    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('joined', { code, myId: socket.id, state: snapshot(room) });
    console.log(`[+] Sala ${code} creada por ${nombre}`);
  });

  socket.on('unirse', ({ code, nombre, equipo } = {}) => {
    nombre = typeof nombre === 'string' ? nombre.trim().slice(0, 20) : '';
    code = typeof code === 'string'
      ? code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
      : '';

    if (!nombre || code.length !== 5 || !EQUIPOS.includes(equipo)) {
      socket.emit('err', 'Faltan datos vÃ¡lidos para unirte.');
      return;
    }

    const room = rooms.get(code);
    if (!room) {
      socket.emit('err', 'Sala no encontrada. Revisa el cÃ³digo.');
      return;
    }
    if (room.terminado) {
      socket.emit('err', 'Esta partida ya terminÃ³. Pide al facilitador reiniciarla.');
      return;
    }

    const jugadoresEnEquipo = [...room.players.values()].filter(
      (player) => player.equipo === equipo
    ).length;

    if (jugadoresEnEquipo >= MAX_JUGADORES_EQUIPO) {
      socket.emit('err', `El equipo ${equipo} ya tiene ${MAX_JUGADORES_EQUIPO} jugadores.`);
      return;
    }

    room.players.set(socket.id, nuevoJugador(nombre, equipo));
    socket.join(code);
    socket.roomCode = code;
    socket.emit('joined', { code, myId: socket.id, state: snapshot(room) });
    broadcast(room);
    toast(room, `${nombre} se uniÃ³ al Equipo ${equipo} ðŸ‘‹`, 'join');
    console.log(`[+] ${nombre} se uniÃ³ a sala ${code} (${equipo})`);
  });

  socket.on('usar-verde', () => {
    const room = getRoom();
    const player = getPlayer(room);
    if (!room || room.terminado || !player || player.fichas.verde <= 0) return;

    player.fichas.verde -= 1;
    player.usadas.verde += 1;
    player.puntos += 1;
    broadcast(room);
  });

  socket.on('usar-amarillo', () => {
    const room = getRoom();
    const player = getPlayer(room);
    if (!room || room.terminado || !player || player.fichas.amarillo <= 0) return;

    player.fichas.amarillo -= 1;
    player.usadas.amarillo += 1;
    player.fichas.rojo = Math.min(MAX_ROJO, player.fichas.rojo + 1);
    player.puntos += 3;
    broadcast(room);
  });

  socket.on('devolver-verde', () => {
    const room = getRoom();
    const player = getPlayer(room);
    if (
      !room || room.terminado || !player || player.usadas.verde <= 0 ||
      player.fichas.verde >= MAX_VERDE || player.puntos < 1
    ) return;

    player.fichas.verde += 1;
    player.usadas.verde -= 1;
    player.puntos -= 1;
    broadcast(room);
  });

  socket.on('devolver-amarillo', () => {
    const room = getRoom();
    const player = getPlayer(room);
    if (
      !room || room.terminado || !player || player.usadas.amarillo <= 0 ||
      player.fichas.amarillo >= MAX_AMARILLO || player.fichas.rojo <= 0 ||
      player.puntos < 3
    ) return;

    player.fichas.amarillo += 1;
    player.usadas.amarillo -= 1;
    player.fichas.rojo -= 1;
    player.puntos -= 3;
    broadcast(room);
  });

  // Conserva la regeneraciÃ³n de las rondas 2 y 6. Es idempotente.
  socket.on('aplicar-regen', () => {
    const room = getRoom();
    if (!room || room.terminado || !esFacilitador(room)) return;

    if (aplicarRegeneracion(room)) {
      broadcast(room);
      toast(room, 'ðŸŒ± RegeneraciÃ³n aplicada a todos los jugadores.', 'success');
    } else {
      socket.emit('toast', { msg: 'La regeneraciÃ³n de esta ronda ya fue aplicada.', tipo: 'info' });
    }
  });

  // Banco de Gobierno en ronda 3 y banco limitado durante la crisis de ronda 5.
  socket.on('tomar-banco', ({ tipo } = {}) => {
    const room = getRoom();
    const player = getPlayer(room);
    if (
      !room || room.terminado || !player || ![3, 5].includes(room.ronda) ||
      !['verde', 'amarillo'].includes(tipo)
    ) return;

    if (room.banco[tipo] <= 0) {
      socket.emit('toast', { msg: `El banco no tiene mÃ¡s fichas ${tipo}.`, tipo: 'error' });
      return;
    }

    const limite = tipo === 'verde' ? MAX_VERDE : MAX_AMARILLO;
    if (player.fichas[tipo] >= limite) {
      socket.emit('toast', { msg: `Ya tienes el mÃ¡ximo de fichas ${tipo}.`, tipo: 'error' });
      return;
    }

    room.banco[tipo] -= 1;
    player.fichas[tipo] += 1;
    broadcast(room);
    toast(
      room,
      `${player.nombre} tomÃ³ una ficha ${tipo} del ${room.ronda === 3 ? 'Banco de Gobierno' : 'banco de crisis'} ðŸ¦`,
      'info'
    );
  });

  // Ronda 3: entrega 2 residuos y recibe 1 ficha verde.
  socket.on('intercambiar-residuos', () => {
    const room = getRoom();
    const player = getPlayer(room);
    if (!room || room.terminado || room.ronda !== 3 || !player) return;

    if (player.fichas.rojo < 2) {
      socket.emit('toast', { msg: 'Necesitas 2 residuos para realizar el canje.', tipo: 'error' });
      return;
    }
    if (player.fichas.verde >= MAX_VERDE) {
      socket.emit('toast', { msg: 'Ya tienes el mÃ¡ximo de fichas verdes.', tipo: 'error' });
      return;
    }

    player.fichas.rojo -= 2;
    player.fichas.verde += 1;
    broadcast(room);
    toast(room, `${player.nombre} canjeÃ³ 2 residuos por 1 ficha verde â™»ï¸`, 'success');
  });

  // Ronda 3: +1 verde para cada integrante de equipos con promedio de residuos <= 2.
  socket.on('aplicar-subsidio', () => {
    const room = getRoom();
    if (
      !room || room.terminado || room.ronda !== 3 || !esFacilitador(room) ||
      room.subsidioAplicado
    ) return;

    const equipos = {};
    room.players.forEach((player) => {
      if (!equipos[player.equipo]) equipos[player.equipo] = [];
      equipos[player.equipo].push(player);
    });

    const elegibles = [];
    Object.entries(equipos).forEach(([equipo, players]) => {
      const promedio = players.reduce((total, player) => total + player.fichas.rojo, 0) / players.length;
      if (promedio <= 2) {
        elegibles.push(equipo);
        players.forEach((player) => {
          player.fichas.verde = Math.min(MAX_VERDE, player.fichas.verde + 1);
        });
      }
    });

    room.subsidioAplicado = true;
    broadcast(room);
    toast(
      room,
      elegibles.length
        ? `ðŸŽ Subsidio aplicado a: ${elegibles.map((equipo) => `Equipo ${equipo}`).join(', ')}.`
        : 'No hubo equipos elegibles para el subsidio.',
      elegibles.length ? 'success' : 'info'
    );
  });

  socket.on('sig-ronda', () => {
    const room = getRoom();
    if (
      !room || room.terminado || !esFacilitador(room) || room.ronda >= TOTAL_RONDAS
    ) return;

    room.ronda += 1;
    configurarRonda(room);
    broadcast(room);
    toast(room, `ðŸš€ Â¡Ronda ${room.ronda} de ${TOTAL_RONDAS} comenzando!`, 'round');
    console.log(`[>] Sala ${room.code} avanzÃ³ a ronda ${room.ronda}`);
  });

  socket.on('finalizar', () => {
    const room = getRoom();
    if (
      !room || room.terminado || !esFacilitador(room) || room.ronda !== TOTAL_RONDAS
    ) return;

    // Garantiza que la regeneraciÃ³n final estÃ© aplicada antes del resultado.
    aplicarRegeneracion(room);
    room.terminado = true;
    room.resultadoFinal = calcularResultado(room);
    broadcast(room);

    const nombres = room.resultadoFinal.ganadores
      .map((equipo) => `Equipo ${equipo}`)
      .join(' y ');
    const empate = room.resultadoFinal.ganadores.length > 1;

    toast(
      room,
      empate
        ? `ðŸ† Â¡Empate! ${nombres} ganan con ${room.resultadoFinal.puntajeGanador} puntos.`
        : `ðŸ† Â¡${nombres} gana con ${room.resultadoFinal.puntajeGanador} puntos!`,
      'success'
    );
    console.log(`[âœ“] Sala ${room.code} finalizada: ${nombres}`);
  });

  socket.on('reiniciar', () => {
    const room = getRoom();
    if (!room || !esFacilitador(room)) return;

    room.ronda = 1;
    room.banco = { ...BANCO_GOBIERNO };
    room.regenAplicada = { 2: false, 6: false };
    room.subsidioAplicado = false;
    room.terminado = false;
    room.resultadoFinal = null;

    room.players.forEach((player) => {
      player.fichas = { ...FICHAS_INICIO };
      player.usadas = { verde: 0, amarillo: 0 };
      player.puntos = 0;
    });

    broadcast(room);
    toast(room, 'ðŸ”„ Juego reiniciado.', 'info');
  });

  socket.on('disconnect', () => {
    const room = getRoom();
    if (!room) return;

    const player = room.players.get(socket.id);
    room.players.delete(socket.id);

    if (room.facilitador === socket.id) {
      if (room.players.size === 0) {
        rooms.delete(room.code);
        return;
      }

      const nuevoFacilitadorId = room.players.keys().next().value;
      const nuevoFacilitador = room.players.get(nuevoFacilitadorId);

      room.facilitador = nuevoFacilitadorId;
      room.facilitadorNombre = nuevoFacilitador.nombre;
      room.players.delete(nuevoFacilitadorId);
      toast(room, 'âš™ï¸ Se asignÃ³ un nuevo facilitador.', 'info');
    }

    broadcast(room);
    if (player) toast(room, `${player.nombre} se desconectÃ³.`, 'info');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`âœ… Reto de los Recursos corriendo en puerto ${PORT}`);
});
