const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public')); // This serves your HTML/JS files

let players = {};
app.get('/favicon.ico', (req, res) => res.status(204).end());
io.on('connection', (socket) => {
    const room = socket.handshake.query.room || 'lobby';
    console.log(`User ${socket.id} joined room: ${room}`);
    socket.join(room);;

// Create player state
    players[socket.id] = { 
        x: 400, 
        y: 300, 
        color: '#' + Math.floor(Math.random()*16777215).toString(16),
        room: room 
    };

// ONLY send existing players who are in the SAME room
    const playersInRoom = {};
    Object.keys(players).forEach((id) => {
        if (players[id].room === room) {
            playersInRoom[id] = players[id];
        }
    });
    socket.emit('currentPlayers', playersInRoom);

    // Tell others in THAT ROOM a new player joined
    socket.to(room).emit('newPlayer', { id: socket.id, player: players[socket.id] });

    // When moving, only broadcast to people in the same room
    socket.on('playerMovement', (movementData) => {
        players[socket.id].x = movementData.x;
        players[socket.id].y = movementData.y;
        socket.to(room).emit('playerMoved', { id: socket.id, x: players[socket.id].x, y: players[socket.id].y });
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.to(room).emit('playerDisconnected', socket.id);
    });
});

http.listen(3000, () => { console.log('Server running on port 3000'); });