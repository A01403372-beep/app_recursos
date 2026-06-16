const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── Constantes ───────────────────────────────────────────────────
const FICHAS_INICIO    = { verde: 8, amarillo: 5, rojo: 0 };
const USADAS_INICIO    = { verde: 0, amarillo: 0 };
const BANCO_INICIO     = { verde: 20, amarillo: 15 };
const BANCO_CRISIS     = { verde: 10, amarillo: 8 };
const MAX_VERDE        = 14;
const MAX_AMARILLO     = 10;
const MAX_ROJO         = 20;
const UMBRAL_SUBSIDIO  = 2;   // residuos ≤ esto → recibe subsidio
const CANJE_ROJAS      = 2;   // cuántas rojas cuesta el canje

// Configuración narrativa de las 6 rondas
const RONDAS = [
  null,
  { modo: 'libre',    nombre: 'Uso libre',         emoji: '🔓' },
  { modo: 'regen',    nombre: 'Regeneración',       emoji: '🌱' },
  { modo: 'gobierno', nombre: 'Banco de Gobierno',  emoji: '🏛️' },
  { modo: 'libre',    nombre: 'Uso libre',          emoji: '🔓' },
  { modo: 'crisis',   nombre: 'Crisis de Recursos', emoji: '⚠️' },
  { modo: 'regen',    nombre: 'Regeneración final', emoji: '🌱' },
];

// ── Helpers ──────────────────────────────────────────────────────
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function nuevoJugador(nombre, equipo) {
  return {
    nombre,
    equipo,
    fichas: { ...FICHAS_INICIO },
    usadas: { ...USADAS_INICIO },  // fichas ya colocadas en la torre
    puntos: 0
  };
}

function snapshot(room) {
  const players = {};
  room.players.forEach((p, id) => {
    players[id] = {
      nombre: p.nombre,
      equipo: p.equipo,
      fichas: { ...p.fichas },
      usadas: { ...p.usadas },
      puntos: p.puntos
    };
  });
  return {
    code:              room.code,
    ronda:             room.ronda,
    players,
    banco:             { ...room.banco },
    bancoCrisis:       { ...room.bancoCrisis },
    facilitador:       room.facilitador,
    subsidiosAplicados: { ...room.subsidiosAplicados }
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', snapshot(room));
}

function toast(room, msg, tipo = 'info') {
  io.to(room.code).emit('toast', { msg, tipo });
}

// Calcula residuos promedio del equipo de un jugador
function residuosPromedioEquipo(room, equipo) {
  const miembros = [...room.players.values()].filter(p => p.equipo === equipo);
  if (!miembros.length) return 0;
  const total = miembros.reduce((s, p) => s + p.fichas.rojo, 0);
  return total / miembros.length;
}

// Aplica regeneración de verdes según residuos acumulados
function aplicarRegen(room) {
  room.players.forEach(p => {
    const regen = Math.max(0, 3 - Math.floor(p.fichas.rojo / 2));
    p.fichas.verde = Math.min(MAX_VERDE, p.fichas.verde + regen);
  });
}

// ── Limpieza de salas vacías (cada 30 min) ───────────────────────
setInterval(() => {
  const ahora = Date.now();
  rooms.forEach((room, code) => {
    if (room.players.size === 0 && ahora - room.creadaEn > 30 * 60 * 1000) {
      rooms.delete(code);
      console.log(`[~] Sala ${code} eliminada por inactividad`);
    }
  });
}, 10 * 60 * 1000);

const rooms = new Map();

// ── Socket.io ────────────────────────────────────────────────────
io.on('connection', (socket) => {

  function getRoom() {
    return socket.roomCode ? rooms.get(socket.roomCode) : null;
  }

  // ── Crear sala ───────────────────────────────────────────────
  socket.on('crear', ({ nombre, equipo }) => {
    if (!nombre || !equipo) { socket.emit('err', 'Nombre y equipo requeridos'); return; }
    let code;
    do { code = genCode(); } while (rooms.has(code));

    const room = {
      code,
      ronda:              1,
      players:            new Map([[socket.id, nuevoJugador(nombre, equipo)]]),
      banco:              { ...BANCO_INICIO },
      bancoCrisis:        { verde: 0, amarillo: 0 },
      facilitador:        socket.id,
      subsidiosAplicados: {},
      creadaEn:           Date.now()
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('joined', { code, myId: socket.id, state: snapshot(room) });
    console.log(`[+] Sala ${code} creada por ${nombre}`);
  });

  // ── Unirse a sala ────────────────────────────────────────────
  socket.on('unirse', ({ code, nombre, equipo }) => {
    if (!nombre || !equipo || !code) { socket.emit('err', 'Faltan datos'); return; }
    code = code.trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('err', 'Sala no encontrada. Revisa el código.'); return; }

    const enEquipo = [...room.players.values()].filter(p => p.equipo === equipo).length;
    if (enEquipo >= 6) { socket.emit('err', `El equipo ${equipo} ya tiene 6 jugadores (máximo).`); return; }

    room.players.set(socket.id, nuevoJugador(nombre, equipo));
    socket.join(code);
    socket.roomCode = code;
    socket.emit('joined', { code, myId: socket.id, state: snapshot(room) });
    broadcast(room);
    toast(room, `${nombre} se unió al Equipo ${equipo} 👋`, 'join');
    console.log(`[+] ${nombre} se unió a ${code} (${equipo})`);
  });

  // ── Usar ficha verde ─────────────────────────────────────────
  socket.on('usar-verde', () => {
    const room = getRoom(); if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || p.fichas.verde <= 0) return;
    p.fichas.verde--;
    p.usadas.verde++;
    p.puntos++;
    broadcast(room);
  });

  // ── Usar ficha amarilla ──────────────────────────────────────
  socket.on('usar-amarillo', () => {
    const room = getRoom(); if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || p.fichas.amarillo <= 0) return;
    p.fichas.amarillo--;
    p.usadas.amarillo++;
    p.fichas.rojo = Math.min(MAX_ROJO, p.fichas.rojo + 1);
    p.puntos += 3;
    broadcast(room);
  });

  // ── Deshacer: devolver verde ─────────────────────────────────
  socket.on('devolver-verde', () => {
    const room = getRoom(); if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || p.puntos < 1 || p.usadas.verde <= 0) return;
    p.fichas.verde++;
    p.usadas.verde--;
    p.puntos = Math.max(0, p.puntos - 1);
    broadcast(room);
  });

  // ── Deshacer: devolver amarilla ──────────────────────────────
  socket.on('devolver-amarillo', () => {
    const room = getRoom(); if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || p.puntos < 3 || p.fichas.rojo <= 0 || p.usadas.amarillo <= 0) return;
    p.fichas.amarillo++;
    p.usadas.amarillo--;
    p.fichas.rojo = Math.max(0, p.fichas.rojo - 1);
    p.puntos = Math.max(0, p.puntos - 3);
    broadcast(room);
  });

  // ── Tomar del banco de gobierno (ronda 3) ────────────────────
  socket.on('tomar-banco', ({ tipo }) => {
    const room = getRoom(); if (!room) return;
    if (RONDAS[room.ronda]?.modo !== 'gobierno') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (!room.banco[tipo] || room.banco[tipo] <= 0) {
      socket.emit('toast', { msg: `El banco no tiene más fichas ${tipo}`, tipo: 'error' });
      return;
    }
    room.banco[tipo]--;
    if (tipo === 'verde')    p.fichas.verde    = Math.min(MAX_VERDE,    p.fichas.verde    + 1);
    if (tipo === 'amarillo') p.fichas.amarillo = Math.min(MAX_AMARILLO, p.fichas.amarillo + 1);
    broadcast(room);
    toast(room, `${p.nombre} tomó 1 ficha ${tipo} del Banco de Gobierno 🏛️`, 'gov');
  });

  // ── Canje de residuos → verde (ronda gobierno) ───────────────
  socket.on('intercambio-residuos', () => {
    const room = getRoom(); if (!room) return;
    if (RONDAS[room.ronda]?.modo !== 'gobierno') return;
    const p = room.players.get(socket.id);
    if (!p || p.fichas.rojo < CANJE_ROJAS) {
      socket.emit('toast', { msg: `Necesitas al menos ${CANJE_ROJAS} residuos 🔴 para canjear`, tipo: 'error' });
      return;
    }
    p.fichas.rojo  -= CANJE_ROJAS;
    p.fichas.verde  = Math.min(MAX_VERDE, p.fichas.verde + 1);
    broadcast(room);
    toast(room, `${p.nombre} canjeó ${CANJE_ROJAS} 🔴 por 1 🟢 verde limpia 🏛️`, 'gov');
  });

  // ── Aplicar subsidios de gobierno (facilitador, ronda 3) ─────
  socket.on('aplicar-subsidios', () => {
    const room = getRoom(); if (!room) return;
    if (room.facilitador !== socket.id) return;
    if (RONDAS[room.ronda]?.modo !== 'gobierno') return;

    room.subsidiosAplicados = {};
    let conteo = 0;
    room.players.forEach((p, id) => {
      const promedio = residuosPromedioEquipo(room, p.equipo);
      if (promedio <= UMBRAL_SUBSIDIO) {
        p.fichas.verde = Math.min(MAX_VERDE, p.fichas.verde + 1);
        room.subsidiosAplicados[id] = true;
        conteo++;
      }
    });

    broadcast(room);
    toast(room,
      conteo > 0
        ? `🏛️ Subsidio aplicado: ${conteo} jugadores con pocos residuos reciben 1 🟢`
        : '🏛️ Ningún equipo calificó para subsidio esta vez',
      'gov'
    );
  });

  // ── Tomar del banco de crisis (ronda 5) ──────────────────────
  socket.on('tomar-crisis', ({ tipo }) => {
    const room = getRoom(); if (!room) return;
    if (RONDAS[room.ronda]?.modo !== 'crisis') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (!room.bancoCrisis[tipo] || room.bancoCrisis[tipo] <= 0) {
      socket.emit('toast', { msg: `¡El banco de crisis ya no tiene fichas ${tipo}! ⚠️`, tipo: 'error' });
      return;
    }
    room.bancoCrisis[tipo]--;
    if (tipo === 'verde')    p.fichas.verde    = Math.min(MAX_VERDE,    p.fichas.verde    + 1);
    if (tipo === 'amarillo') p.fichas.amarillo = Math.min(MAX_AMARILLO, p.fichas.amarillo + 1);
    broadcast(room);
    toast(room, `${p.nombre} tomó 1 ${tipo} del banco de crisis ⚠️`, 'info');
  });

  // ── Aplicar regeneración manual (facilitador) ────────────────
  socket.on('aplicar-regen', () => {
    const room = getRoom(); if (!room) return;
    if (room.facilitador !== socket.id) return;
    if (RONDAS[room.ronda]?.modo !== 'regen') return;
    aplicarRegen(room);
    broadcast(room);
    toast(room, '🌱 Regeneración aplicada — residuos reducen fichas recuperadas', 'success');
  });

  // ── Avanzar ronda ────────────────────────────────────────────
  socket.on('sig-ronda', () => {
    const room = getRoom(); if (!room) return;
    if (room.facilitador !== socket.id) return;
    if (room.ronda >= 6) return;

    const modoActual = RONDAS[room.ronda]?.modo;
    const modoSig    = RONDAS[room.ronda + 1]?.modo;

    // Efectos al SALIR de la ronda actual
    if (modoActual === 'regen') {
      // Regeneración automática al avanzar desde ronda de regen
      aplicarRegen(room);
    }

    room.ronda++;

    // Efectos al ENTRAR a la nueva ronda
    if (modoSig === 'gobierno') {
      room.banco              = { ...BANCO_INICIO };
      room.subsidiosAplicados = {};
    }
    if (modoSig === 'crisis') {
      room.bancoCrisis = { ...BANCO_CRISIS };
    }
    if (modoSig === 'regen') {
      // La regeneración la aplica el facilitador manualmente o se aplica al avanzar
    }
    if (modoSig === 'libre') {
      // Segunda ronda libre: nada especial al entrar
    }

    const cfg = RONDAS[room.ronda];
    broadcast(room);
    io.to(room.code).emit('round-changed', { round: room.ronda });
    toast(room, `${cfg.emoji} ¡Ronda ${room.ronda} — ${cfg.nombre}!`, 'round');
    console.log(`[>] Sala ${room.code} avanzó a ronda ${room.ronda} (${cfg.modo})`);
  });

  // ── Reiniciar juego ──────────────────────────────────────────
  socket.on('reiniciar', () => {
    const room = getRoom(); if (!room) return;
    if (room.facilitador !== socket.id) return;
    room.ronda              = 1;
    room.banco              = { ...BANCO_INICIO };
    room.bancoCrisis        = { verde: 0, amarillo: 0 };
    room.subsidiosAplicados = {};
    room.players.forEach(p => {
      p.fichas = { ...FICHAS_INICIO };
      p.usadas = { ...USADAS_INICIO };
      p.puntos = 0;
    });
    broadcast(room);
    toast(room, '🔄 Juego reiniciado — ¡a empezar de nuevo!', 'info');
  });

  // ── Desconexión ──────────────────────────────────────────────
  socket.on('disconnect', () => {
    const room = getRoom(); if (!room) return;
    const p = room.players.get(socket.id);
    room.players.delete(socket.id);
    if (room.players.size === 0) return;

    // Si el facilitador se va, el primer jugador restante toma el rol
    if (room.facilitador === socket.id) {
      room.facilitador = room.players.keys().next().value;
      const nuevo = room.players.get(room.facilitador);
      toast(room, `${nuevo?.nombre} es ahora el facilitador ⚙️`, 'info');
    }

    broadcast(room);
    if (p) toast(room, `${p.nombre} se desconectó`, 'info');
  });
});

// ── Inicio ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Reto de los Recursos corriendo en puerto ${PORT}`);
});
