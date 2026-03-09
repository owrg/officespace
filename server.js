// server.js (debug-friendly)
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));
app.get('/favicon.ico', (req, res) => res.status(204).end());

let players = {};
let nextAvatarRow = 0;
const TOTAL_AVATAR_ROWS = 8;

function safeName(name) {
  if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 20);
  return 'Anon';
}

io.on('connection', (socket) => {
  const room = (socket.handshake && socket.handshake.query && socket.handshake.query.room) || 'lobby';
  console.log(`[server] connection: socket.id=${socket.id}, handshakeQuery=`, socket.handshake && socket.handshake.query);
  socket.join(room);

  // If the client already sent name/avatarRow in handshake query, create player immediately
  const hq = socket.handshake && socket.handshake.query;
  if (hq && (hq.name || hq.avatarRow !== undefined)) {
    const requestedRow = (hq.avatarRow !== undefined) ? parseInt(hq.avatarRow, 10) : undefined;
    const assignedRow = (typeof requestedRow === 'number' && requestedRow >= 0 && requestedRow < TOTAL_AVATAR_ROWS) ? requestedRow : nextAvatarRow;
    if (requestedRow === undefined || !(requestedRow >= 0 && requestedRow < TOTAL_AVATAR_ROWS)) {
      nextAvatarRow = (nextAvatarRow + 1) % TOTAL_AVATAR_ROWS;
    }
    players[socket.id] = {
      x: 400, y: 300, room: room,
      avatarRow: assignedRow,
      anim: null, frame: null,
      name: safeName(hq.name)
    };
    console.log(`[server] auto-joined player for socket ${socket.id}:`, players[socket.id]);

    // send snapshot to this socket
    const playersInRoom = {};
    Object.keys(players).forEach(id => { if (players[id].room === room) playersInRoom[id] = players[id]; });
    socket.emit('currentPlayers', playersInRoom);

    // notify others
    socket.to(room).emit('newPlayer', { id: socket.id, player: players[socket.id] });
  }

  // fallback: explicit join event (client may choose to connect first then emit join)
  socket.on('join', ({ name, avatarRow }) => {
    console.log(`[server] join received from ${socket.id}:`, { name, avatarRow });
    if (players[socket.id]) {
      console.log(`[server] player already exists for ${socket.id} (ignoring join)`);
      return;
    }

    const requestedRow = (typeof avatarRow === 'number') ? avatarRow : undefined;
    const assignedRow = (typeof requestedRow === 'number' && requestedRow >= 0 && requestedRow < TOTAL_AVATAR_ROWS) ? requestedRow : nextAvatarRow;
    if (requestedRow === undefined || !(requestedRow >= 0 && requestedRow < TOTAL_AVATAR_ROWS)) {
      nextAvatarRow = (nextAvatarRow + 1) % TOTAL_AVATAR_ROWS;
    }

    players[socket.id] = {
      x: 400, y: 300, room: room,
      avatarRow: assignedRow,
      anim: null, frame: null,
      name: safeName(name)
    };

    const playersInRoom = {};
    Object.keys(players).forEach(id => { if (players[id].room === room) playersInRoom[id] = players[id]; });
    socket.emit('currentPlayers', playersInRoom);
    socket.to(room).emit('newPlayer', { id: socket.id, player: players[socket.id] });

    console.log(`[server] join handled: ${socket.id} =>`, players[socket.id]);
  });

  socket.on('playerMovement', (movementData) => {
    if (!players[socket.id]) return;
    players[socket.id].x = movementData.x;
    players[socket.id].y = movementData.y;
    players[socket.id].anim = movementData.anim || null;
    players[socket.id].frame = (movementData.frame !== undefined) ? movementData.frame : null;

    socket.to(players[socket.id].room).emit('playerMoved', {
      id: socket.id,
      x: players[socket.id].x,
      y: players[socket.id].y,
      anim: players[socket.id].anim,
      frame: players[socket.id].frame,
      avatarRow: players[socket.id].avatarRow,
      name: players[socket.id].name
    });
  });

  socket.on('disconnect', () => {
    console.log('[server] disconnect', socket.id);
    const r = players[socket.id] ? players[socket.id].room : null;
    delete players[socket.id];
    if (r) io.to(r).emit('playerDisconnected', socket.id);
  });
});

http.listen(3000, () => console.log('Server running on port 3000'));