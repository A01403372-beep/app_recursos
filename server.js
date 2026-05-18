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
  for (let i = 0; i < 5; i++) s += c[Math.floor(Math.random() * c.length)];
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

function snapshot(room) {
  const players = {};
  room.players.forEach((p, id) => {
    players[id] = {
      nombre: p.nombre,
      equipo: p.equipo,
      fichas: { ...p.fichas },
      puntos: p.puntos
    };
  });
  return {
    code:   room.code,
    ronda:  room.ronda,
    players,
    banco:  { ...room.banco }
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', snapshot(room));
}

function toast(room, msg, tipo = 'info') {
  io.to(room.code).emit('toast', { msg, tipo });
}

// ── Limpieza de salas vacías (cada 30 min) ───────────────────────
setInterval(() => {
  const ahora = Date.now();
  rooms.forEach((room, code) => {
    if (room.players.size === 0 && ahora - room.creadaEn > 30 * 60 * 1000) {
      rooms.delete(code);
    }
  });
}, 10 * 60 * 1000);

// ── Socket.io ────────────────────────────────────────────────────
io.on('connection', (socket) => {

  function getRoom() {
    return socket.roomCode ? rooms.get(socket.roomCode) : null;
  }

  // Crear sala nueva
  socket.on('crear', ({ nombre, equipo }) => {
    if (!nombre || !equipo) { socket.emit('err', 'Nombre y equipo requeridos'); return; }
    let code;
    do { code = genCode(); } while (rooms.has(code));

    const room = {
      code,
      ronda: 1,
      players: new Map([[socket.id, nuevoJugador(nombre, equipo)]]),
      banco: { ...BANCO_INICIO },
      creadaEn: Date.now()
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('joined', { code, myId: socket.id, state: snapshot(room) });
    console.log(`[+] Sala ${code} creada por ${nombre}`);
  });

  // Unirse a sala existente
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
    console.log(`[+] ${nombre} se unió a sala ${code} (${equipo})`);
  });

  // Usar ficha verde: -1 verde, +1 punto
  socket.on('usar-verde', () => {
    const room = getRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || p.fichas.verde <= 0) return;
    p.fichas.verde--;
    p.puntos += 1;
    broadcast(room);
  });

  // Usar ficha amarilla: -1 amarillo, +1 rojo, +3 puntos
  socket.on('usar-amarillo', () => {
    const room = getRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || p.fichas.amarillo <= 0) return;
    p.fichas.amarillo--;
    p.fichas.rojo = Math.min(MAX_ROJO, p.fichas.rojo + 1);
    p.puntos += 3;
    broadcast(room);
  });

  // Deshacer: devolver ficha verde
  socket.on('devolver-verde', () => {
    const room = getRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || p.fichas.verde >= MAX_VERDE || p.puntos < 1) return;
    p.fichas.verde++;
    p.puntos = Math.max(0, p.puntos - 1);
    broadcast(room);
  });

  // Deshacer: devolver ficha amarilla
  socket.on('devolver-amarillo', () => {
    const room = getRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || p.fichas.amarillo >= MAX_AMARILLO || p.puntos < 3 || p.fichas.rojo <= 0) return;
    p.fichas.amarillo++;
    p.fichas.rojo = Math.max(0, p.fichas.rojo - 1);
    p.puntos = Math.max(0, p.puntos - 3);
    broadcast(room);
  });

  // Aplicar regeneración manual (ronda 2)
  socket.on('aplicar-regen', () => {
    const room = getRoom();
    if (!room || room.ronda !== 2) return;
    room.players.forEach(p => {
      const regen = Math.max(0, 3 - Math.floor(p.fichas.rojo / 2));
      p.fichas.verde = Math.min(MAX_VERDE, p.fichas.verde + regen);
    });
    broadcast(room);
    toast(room, '🌱 Regeneración aplicada a todos los equipos', 'success');
  });

  // Tomar del banco común (solo ronda 3)
  socket.on('tomar-banco', ({ tipo }) => {
    const room = getRoom();
    if (!room || room.ronda !== 3) return;
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
    toast(room, `${p.nombre} tomó una ficha ${tipo} del banco 🏦`, 'info');
  });

  // Avanzar a la siguiente ronda
  socket.on('sig-ronda', () => {
    const room = getRoom();
    if (!room || room.ronda >= 3) return;

    // Al entrar a ronda 2 → regenerar verdes
    if (room.ronda === 1) {
      room.players.forEach(p => {
        const regen = Math.max(0, 3 - Math.floor(p.fichas.rojo / 2));
        p.fichas.verde = Math.min(MAX_VERDE, p.fichas.verde + regen);
      });
    }

    room.ronda++;

    // Al entrar a ronda 3 → activar banco
    if (room.ronda === 3) {
      room.banco = { ...BANCO_INICIO };
    }

    broadcast(room);
    toast(room, `🚀 ¡Ronda ${room.ronda} comenzando!`, 'round');
    console.log(`[>] Sala ${room.code} avanzó a ronda ${room.ronda}`);
  });

  // Reiniciar juego
  socket.on('reiniciar', () => {
    const room = getRoom();
    if (!room) return;
    room.ronda = 1;
    room.banco = { ...BANCO_INICIO };
    room.players.forEach(p => {
      p.fichas = { ...FICHAS_INICIO };
      p.puntos = 0;
    });
    broadcast(room);
    toast(room, '🔄 Juego reiniciado', 'info');
  });

  // Desconexión
  socket.on('disconnect', () => {
    const room = getRoom();
    if (!room) return;
    const p = room.players.get(socket.id);
    room.players.delete(socket.id);
    if (room.players.size === 0) return;
    broadcast(room);
    if (p) toast(room, `${p.nombre} se desconectó`, 'info');
  });
});

// ── Inicio ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Reto de los Recursos corriendo en puerto ${PORT}`);
});
