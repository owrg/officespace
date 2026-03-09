// 1. Declare variables at the top so they are "Global"
let socket;
let player;
let otherPlayers;

// 2. Get the room ID
const urlParams = new URLSearchParams(window.location.search);
const roomID = urlParams.get('room') || 'lobby';

// 3. Initialize the connection
socket = io({
    query: { room: roomID },
    transports: ['websocket'] // This forces it to skip polling
});

// 4. Your Phaser Config
const config = {
    type: Phaser.AUTO,
    parent: 'game-container',
    width: 800,
    height: 600,
    scene: { preload: preload, create: create, update: update }
};

const game = new Phaser.Game(config);
function preload() {}

function create() {
    otherPlayers = this.add.group();
    
    // 1. Get initial state
    socket.on('currentPlayers', (players) => {
        Object.keys(players).forEach((id) => {
            if (id === socket.id) {
                addPlayer(this, players[id]);
            } else {
                addOtherPlayers(this, players[id], id);
            }
        });
    });

    // 2. Handle new people joining
    socket.on('newPlayer', (data) => {
        addOtherPlayers(this, data.player, data.id);
    });

    // 3. Move other people on your screen
    socket.on('playerMoved', (data) => {
        otherPlayers.getChildren().forEach((otherPlayer) => {
            if (data.id === otherPlayer.playerId) {
                otherPlayer.setPosition(data.x, data.y);
            }
        });
    });

    this.cursors = this.input.keyboard.createCursorKeys();
}

function update() {
    if (player) {
        const speed = 5;
        let moved = false;

        if (this.cursors.left.isDown) { player.x -= speed; moved = true; }
        else if (this.cursors.right.isDown) { player.x += speed; moved = true; }
        
        if (this.cursors.up.isDown) { player.y -= speed; moved = true; }
        else if (this.cursors.down.isDown) { player.y += speed; moved = true; }

        if (moved) {
            socket.emit('playerMovement', { x: player.x, y: player.y });
        }
    }
}

function addPlayer(scene, info) {
    player = scene.add.rectangle(info.x, info.y, 30, 30, info.color.replace('#', '0x'));
}

function addOtherPlayers(scene, info, id) {
    const otherPlayer = scene.add.rectangle(info.x, info.y, 30, 30, info.color.replace('#', '0x'));
    otherPlayer.playerId = id;
    otherPlayers.add(otherPlayer);
}