const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public')); // This serves your HTML/JS files

let players = {};

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // Create a new player object
    players[socket.id] = { x: 400, y: 300, color: '#' + Math.floor(Math.random()*16777215).toString(16) };

    // Tell the new player about everyone else, and tell everyone about the new player
    socket.emit('currentPlayers', players);
    socket.broadcast.emit('newPlayer', { id: socket.id, player: players[socket.id] });

    // When a player moves, update the 'Brain' and tell others
    socket.on('playerMovement', (movementData) => {
        players[socket.id].x = movementData.x;
        players[socket.id].y = movementData.y;
        socket.broadcast.emit('playerMoved', { id: socket.id, x: players[socket.id].x, y: players[socket.id].y });
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);
    });
});

http.listen(3000, () => { console.log('Server running on port 3000'); });