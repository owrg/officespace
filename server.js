const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public')); // This serves your HTML/JS files

let players = {};
app.get('/favicon.ico', (req, res) => res.status(204).end());


let nextAvatarRow = 0; // Initialize counter outside the connection block
const TOTAL_AVATAR_ROWS = 8; // Your sprite sheet has 8 rows of people

io.on('connection', (socket) => {
    const room = socket.handshake.query.room || 'lobby';
    socket.join(room);
//    console.log(`User ${socket.id} joined room: ${room}`);

    let assignedRow = nextAvatarRow;
    nextAvatarRow = (nextAvatarRow + 1) % TOTAL_AVATAR_ROWS;
//    console.log(`Assigning unique avatar row ${assignedRow} to connection ${socket.id}`);

    // CREATE the player data and SAVE THE ROW
    players[socket.id] = { 
        x: 400, // Spawn coordinates
        y: 300, 
        room: room,
        avatarRow: assignedRow, // CRITICAL: Store which person they are!
        anim: null,
        frame: null
    };

    const playersInRoom = {};
    Object.keys(players).forEach((id) => {
        if (players[id].room === room) playersInRoom[id] = players[id];
    });
    socket.emit('currentPlayers', playersInRoom);

    // Pass the ENTIRE player data object (including x, y, and avatarRow)
    socket.to(room).emit('newPlayer', { id: socket.id, player: players[socket.id] });

    // When client moves, update server model and broadcast anim/frame
    // server.js - inside io.on('connection', socket) ...
    socket.on('playerMovement', (movementData) => {
    if (!players[socket.id]) return;

    // update server-side model
    players[socket.id].x = movementData.x;
    players[socket.id].y = movementData.y;

    // store last animation/frame the client sent (may be null when stopped)
    players[socket.id].anim = movementData.anim || null;
    players[socket.id].frame = (movementData.frame !== undefined) ? movementData.frame : null;

    // forward full info to others in same room
    socket.to(room).emit('playerMoved', {
        id: socket.id,
        x: players[socket.id].x,
        y: players[socket.id].y,
        anim: players[socket.id].anim,
        frame: players[socket.id].frame,
        avatarRow: players[socket.id].avatarRow
    });
    });

    socket.on('disconnect', () => {
        const r = players[socket.id] ? players[socket.id].room : null;
        delete players[socket.id];
        if (r) io.to(r).emit('playerDisconnected', socket.id);
    });
});

http.listen(3000, () => { console.log('Server running on port 3000'); });