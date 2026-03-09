// game.js — full file (ready to drop in)
// Includes:
// - socket buffering (don't miss server 'currentPlayers')
// - per-row animations (8 rows × 12 frames)
// - camera follow (player stays centered; background moves)
// - interpolation for remote players
// - server-forwarded anim/frame support + client fallback to auto-stop walking anims
// - sets and uses other.lastDirection so idle frames are correct when players stop

const TOTAL_AVATAR_ROWS = 8;
let socket;
let player;            // local player sprite (Phaser.Physics.Arcade.Sprite)
let otherPlayers;      // Phaser.Group for remote player sprites
let cursors;
let lastDirection = 'down';

// Event queue to buffer socket messages arriving before Phaser scene is ready
const socketEventQueue = {
  currentPlayers: null,
  newPlayers: [],
  playerMoved: [],
  playerDisconnected: []
};

document.addEventListener('DOMContentLoaded', () => {
  // read room from URL query
  const params = new URLSearchParams(window.location.search);
  const roomID = params.get('room') || 'lobby';

  // create socket immediately so we don't miss initial messages
  socket = window.socket = io({
    query: { room: roomID },
    transports: ['websocket']
  });

  // register listeners that push into the queue
  socket.on('currentPlayers', (players) => {
    socketEventQueue.currentPlayers = players;
  });
  socket.on('newPlayer', (data) => {
    socketEventQueue.newPlayers.push(data);
  });
  socket.on('playerMoved', (data) => {
    socketEventQueue.playerMoved.push(data);
  });
  socket.on('playerDisconnected', (id) => {
    socketEventQueue.playerDisconnected.push(id);
  });

  // Phaser config and creation
    const config = {
    type: Phaser.AUTO,
    parent: 'game-container',

    scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: window.innerWidth,
        height: window.innerHeight
    },

    physics: { default: 'arcade', arcade: { debug: false } },
    scene: { preload, create, update }
    };
  const game = new Phaser.Game(config);
});

/* -------------------------
   Phaser lifecycle methods
   ------------------------- */

function preload() {
  // map and spritesheet
  this.load.image('officeMap', 'images/office_space_floor_001.png');
  // adjust frameWidth/frameHeight if necessary for your sheet
  this.load.spritesheet('playerAvatar', 'images/walkcyclevarious.png', { frameWidth: 64, frameHeight: 60 });
}

function create() {
  // add map
  const map = this.add.image(0, 0, 'officeMap').setOrigin(0);
  const texture = this.textures.get('officeMap');
  const mapWidth = texture.getSourceImage().width;
  const mapHeight = texture.getSourceImage().height;

  // world bounds (match server logic if server uses particular bounds)
  this.physics.world.setBounds(-70, 100, mapWidth + 130, mapHeight - 180);

  // create local player (temporary position until server snapshot arrives)
  player = this.physics.add.sprite(400, 300, 'playerAvatar').setScale(4).setCollideWorldBounds(true);
  player.myAvatarRow = 0; // will be overridden when server snapshot arrives
  player.setDepth(1);

  // create container for other players
  otherPlayers = this.add.group();

  // create animations for each row & direction
  for (let row = 0; row < TOTAL_AVATAR_ROWS; row++) {
    const offset = row * 12;
    this.anims.create({
      key: `walk-up-${row}`,
      frames: [
        { key: 'playerAvatar', frame: offset + 0 },
        { key: 'playerAvatar', frame: offset + 1 },
        { key: 'playerAvatar', frame: offset + 2 }
      ],
      frameRate: 10,
      repeat: -1
    });
    this.anims.create({
      key: `walk-right-${row}`,
      frames: [
        { key: 'playerAvatar', frame: offset + 3 },
        { key: 'playerAvatar', frame: offset + 4 },
        { key: 'playerAvatar', frame: offset + 5 }
      ],
      frameRate: 10,
      repeat: -1
    });
    this.anims.create({
      key: `walk-down-${row}`,
      frames: [
        { key: 'playerAvatar', frame: offset + 6 },
        { key: 'playerAvatar', frame: offset + 7 },
        { key: 'playerAvatar', frame: offset + 8 }
      ],
      frameRate: 10,
      repeat: -1
    });
    this.anims.create({
      key: `walk-left-${row}`,
      frames: [
        { key: 'playerAvatar', frame: offset + 9 },
        { key: 'playerAvatar', frame: offset + 10 },
        { key: 'playerAvatar', frame: offset + 11 }
      ],
      frameRate: 10,
      repeat: -1
    });
  }

  // camera follows the local player so player appears centered
  this.cameras.main.setBounds(-70, 100, mapWidth + 130, mapHeight - 180);
  this.cameras.main.startFollow(player, false, 1, 1);
  this.cameras.main.roundPixels = true;
  
  this.scale.on('resize', (gameSize) => {
  const { width, height } = gameSize;
  this.cameras.resize(width, height);
});

  // keyboard input
  cursors = this.input.keyboard.createCursorKeys();

  // --- Process any buffered socket events that arrived before scene ready ---
  if (socketEventQueue.currentPlayers) {
    const players = socketEventQueue.currentPlayers;
    Object.keys(players).forEach((id) => {
      const p = players[id];
      if (id === socket.id) {
        // server assigned our avatarRow; apply
        player.x = p.x;
        player.y = p.y;
        player.myAvatarRow = (p.avatarRow !== undefined) ? p.avatarRow : 0;
        const off = player.myAvatarRow * 12;
        player.setFrame(off + 7);
      } else {
        addOtherPlayer(this, id, p);
      }
    });
    socketEventQueue.currentPlayers = null;
  }

  // drain new players
  while (socketEventQueue.newPlayers.length) {
    const data = socketEventQueue.newPlayers.shift();
    addOtherPlayer(this, data.id, data.player);
  }

  // drain playerMoved events
  while (socketEventQueue.playerMoved.length) {
    const data = socketEventQueue.playerMoved.shift();
    const other = otherPlayers.getChildren().find(sp => sp.playerId === data.id);
    if (!other) continue;
    if (data.avatarRow !== undefined) other.avatarRow = data.avatarRow;
    other.targetX = data.x;
    other.targetY = data.y;
    // if server provided anim, play and record direction; if frame provided, stop anim and set frame
    if (data.anim) {
      other.anims.play(data.anim, true);
      other.lastDirection = directionFromAnimKey(data.anim);
    } else if (data.frame !== undefined && data.frame !== null) {
      other.anims.stop();
      other.setFrame(data.frame);
      other.lastDirection = directionFromFrameIndex(data.frame);
    }
  }

  // drain disconnects
  while (socketEventQueue.playerDisconnected.length) {
    const id = socketEventQueue.playerDisconnected.shift();
    const other = otherPlayers.getChildren().find(sp => sp.playerId === id);
    if (other) other.destroy();
  }

  // Register live socket handlers (these will run after buffering)
  socket.on('newPlayer', (data) => {
    addOtherPlayer(this, data.id, data.player);
  });

  socket.on('playerMoved', (data) => {
    const other = otherPlayers.getChildren().find(sp => sp.playerId === data.id);
    if (!other) return;
    if (data.avatarRow !== undefined) other.avatarRow = data.avatarRow;
    // set targets; we lerp in update()
    other.targetX = data.x;
    other.targetY = data.y;
    if (data.anim) {
      other.anims.play(data.anim, true);
      other.lastDirection = directionFromAnimKey(data.anim);
    } else if (data.frame !== undefined && data.frame !== null) {
      other.anims.stop();
      other.setFrame(data.frame);
      other.lastDirection = directionFromFrameIndex(data.frame);
    }
  });

  socket.on('playerDisconnected', (id) => {
    const other = otherPlayers.getChildren().find(sp => sp.playerId === id);
    if (other) other.destroy();
  });
}

function update() {
  if (!player) return;

  const speed = 250;
  player.setVelocity(0);

  // movement & animations for local player (immediate; local prediction)
  if (cursors.left.isDown) {
    player.setVelocityX(-speed);
    player.anims.play(`walk-left-${player.myAvatarRow}`, true);
    lastDirection = 'left';
  } else if (cursors.right.isDown) {
    player.setVelocityX(speed);
    player.anims.play(`walk-right-${player.myAvatarRow}`, true);
    lastDirection = 'right';
  } else if (cursors.up.isDown) {
    player.setVelocityY(-speed);
    player.anims.play(`walk-up-${player.myAvatarRow}`, true);
    lastDirection = 'up';
  } else if (cursors.down.isDown) {
    player.setVelocityY(speed);
    player.anims.play(`walk-down-${player.myAvatarRow}`, true);
    lastDirection = 'down';
  } else {
    // idle frame (middle frame of each 3-frame set)
    player.anims.stop();
    const offset = player.myAvatarRow * 12;
    if (lastDirection === 'left') player.setFrame(offset + 10);
    else if (lastDirection === 'right') player.setFrame(offset + 4);
    else if (lastDirection === 'up') player.setFrame(offset + 1);
    else player.setFrame(offset + 7);
  }

  // send movement updates only when something changed (position, anim, frame)
  const frameVal = (() => {
    if (!player.frame) return null;
    if (typeof player.frame.index === 'number') return player.frame.index;
    if (typeof player.frame.name === 'number') return player.frame.name;
    return player.frame.name ?? player.frame.index ?? null;
  })();

  const animName = player.anims.currentAnim ? player.anims.currentAnim.key : null;
  if (player.x !== player.oldX || player.y !== player.oldY || animName !== player.oldAnim || frameVal !== player.oldFrame) {
    socket.emit('playerMovement', {
      x: player.x,
      y: player.y,
      anim: animName,
      frame: frameVal
    });
    player.oldX = player.x;
    player.oldY = player.y;
    player.oldAnim = animName;
    player.oldFrame = frameVal;
  }

  // LERP remote players toward their target positions for smooth motion
  const REMOTE_LERP = 0.28;
  const STOP_EPS = 1.6; // pixels tolerance for considering "at rest"

  otherPlayers.getChildren().forEach((other) => {
    if (typeof other.targetX === 'number' && typeof other.targetY === 'number') {
      other.x = Phaser.Math.Linear(other.x, other.targetX, REMOTE_LERP);
      other.y = Phaser.Math.Linear(other.y, other.targetY, REMOTE_LERP);

      // if close enough to target, stop walking anim if it's still playing
      const dx = Math.abs(other.x - other.targetX);
      const dy = Math.abs(other.y - other.targetY);
      if (dx < STOP_EPS && dy < STOP_EPS) {
        if (other.anims && other.anims.isPlaying) {
          other.anims.stop();
          // choose idle frame based on lastDirection (fall back to down)
          const offset = (other.avatarRow ?? 0) * 12;
          const dir = other.lastDirection || 'down';
          if (dir === 'left') other.setFrame(offset + 10);
          else if (dir === 'right') other.setFrame(offset + 4);
          else if (dir === 'up') other.setFrame(offset + 1);
          else other.setFrame(offset + 7);
        }
      }
    }
  });
}

/* -------------------------
   Helper functions
   ------------------------- */

function addOtherPlayer(scene, id, p) {
  const other = scene.add.sprite(p.x, p.y, 'playerAvatar').setScale(4);
  scene.physics.add.existing(other, false);
  other.playerId = id;
  other.avatarRow = (p.avatarRow !== undefined) ? p.avatarRow : 0;
  other.setDepth(1);

  // initial idle frame and lastDirection default
  const off = other.avatarRow * 12;
  other.setFrame(off + 7);
  other.lastDirection = 'down';

  // smoothing targets
  other.targetX = p.x;
  other.targetY = p.y;

  otherPlayers.add(other);
}

// tries to infer 'left'|'right'|'up'|'down' from animation key like "walk-left-2"
function directionFromAnimKey(animKey) {
  if (!animKey || typeof animKey !== 'string') return 'down';
  // expect something like "walk-left-3"
  const parts = animKey.split('-');
  if (parts.length >= 2) return parts[1];
  return 'down';
}

// tries to infer direction from a numeric frame index (0..N). maps per-row 12-frame layout
function directionFromFrameIndex(frameIndex) {
  if (typeof frameIndex !== 'number') return 'down';
  const idx = frameIndex % 12; // within-row index
  if (idx <= 2) return 'up';
  if (idx >= 3 && idx <= 5) return 'right';
  if (idx >= 6 && idx <= 8) return 'down';
  return 'left'; // 9..11
}