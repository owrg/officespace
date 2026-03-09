// game.js — connect-after-join, handshake query, robust labels + logs
const TOTAL_AVATAR_ROWS = 8;
let socket = null;
let player = null;
let otherPlayers = null;
let cursors = null;
let lastDirection = 'down';

const pendingOtherIds = new Set(); // prevent duplicates

// Prejoin UI that connects only when Join pressed
function createPrejoinUI() {
  if (document.getElementById('prejoin')) return;
  const div = document.createElement('div');
  div.id = 'prejoin';
  div.style = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999';
  div.innerHTML = `
    <div style="background:#fff;padding:18px;border-radius:8px;min-width:260px">
      <h3 style="margin:0 0 8px 0">Enter name & character</h3>
      <input id="playerName" placeholder="Your name" style="width:100%;padding:6px;margin-bottom:8px" />
      <label style="display:block;margin-bottom:6px">Character</label>
      <select id="avatarSelect" style="width:100%;padding:6px;margin-bottom:12px">
        ${Array.from({length:TOTAL_AVATAR_ROWS}).map((_,i)=>`<option value="${i}">Character ${i+1}</option>`).join('')}
      </select>
      <button id="joinBtn" style="width:100%;padding:8px">Join</button>
    </div>
  `;
  document.body.appendChild(div);

  document.getElementById('joinBtn').addEventListener('click', () => {
    const name = (document.getElementById('playerName').value || '').trim() || 'Anon';
    const avatarRow = parseInt(document.getElementById('avatarSelect').value || '0', 10);
    sessionStorage.setItem('preferredName', name);
    sessionStorage.setItem('preferredAvatarRow', avatarRow);
    document.getElementById('prejoin').style.display = 'none';
    // connect now, including name/avatarRow in handshake query
    connectSocketAndStart(name, avatarRow);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  createPrejoinUI();
  // if user already has stored name/avatarRow (reload case), auto-show prejoin with those prefilled
  const preName = sessionStorage.getItem('preferredName');
  const preRow = sessionStorage.getItem('preferredAvatarRow');
  if (preName) {
    // prefill fields
    const nameInput = document.getElementById('playerName');
    const avatarSelect = document.getElementById('avatarSelect');
    if (nameInput) nameInput.value = preName;
    if (avatarSelect) avatarSelect.value = preRow || '0';
  }
});

// --- Ensure the "Join" button always has a handler (fixes case where index.html provides the prejoin DOM) ---
function ensurePrejoinHandler() {
  const pre = document.getElementById('prejoin');
  const btn = document.getElementById('joinBtn');
  if (!btn || !pre) {
    // nothing to attach yet; try again shortly
    return;
  }
  if (btn._hasPrejoinHandler) return; // already attached

  btn.addEventListener('click', () => {
    const name = (document.getElementById('playerName').value || '').trim() || 'Anon';
    const avatarRow = parseInt(document.getElementById('avatarSelect').value || '0', 10);
    // save for Phaser scene and reconnect logic
    sessionStorage.setItem('preferredName', name);
    sessionStorage.setItem('preferredAvatarRow', avatarRow);

    // hide the overlay exactly like our UI code expects
    pre.style.display = 'none';

    // If connectSocketAndStart exists (we defined it), use it to connect with handshake query.
    // Otherwise if socket exists and is connected, emit join as a fallback.
    if (typeof connectSocketAndStart === 'function') {
      try { connectSocketAndStart(name, avatarRow); } catch (e) { console.error('connectSocketAndStart error', e); }
    } else if (window.socket && window.socket.connected) {
      window.socket.emit('join', { name, avatarRow });
    } else {
      console.warn('No connect function or socket present; join saved to sessionStorage for later.');
    }

    // Resume audio context on user gesture (avoids autoplay blocking)
    if (window.audioCtx && window.audioCtx.state === 'suspended') {
      window.audioCtx.resume().catch(()=>{});
    }
  });

  btn._hasPrejoinHandler = true;
}

// try to attach on DOMContentLoaded and also schedule a short retry in case scripts load in different order
document.addEventListener('DOMContentLoaded', () => {
  ensurePrejoinHandler();
  // little safety retries to handle racing script loads
  setTimeout(ensurePrejoinHandler, 50);
  setTimeout(ensurePrejoinHandler, 300);
});

// helper to create the socket and start Phaser AFTER join info is known
function connectSocketAndStart(name, avatarRow) {
  console.log('[client] connectSocketAndStart', { name, avatarRow });

  const params = new URLSearchParams(window.location.search);
  const roomID = params.get('room') || 'lobby';

  socket = window.socket = io({
    query: { room: roomID, name: name, avatarRow: avatarRow },
    transports: ['websocket']
  });

  // debug logs
  socket.on('connect', () => console.log('[client] socket connected id=', socket.id));
  socket.on('connect_error', (err) => console.error('[client] connect_error', err));

  // handlers: we will apply directly (no large buffer needed because we only connect after join)
  socket.on('currentPlayers', (players) => {
    console.log('[client] currentPlayers', players);
    if (!player) {
      // Phaser might not have created local player yet; just stash into sessionStorage for now
      sessionStorage.setItem('initialPlayers', JSON.stringify(players));
    } else {
      handleCurrentPlayers(players);
    }
  });

  socket.on('newPlayer', (data) => {
    console.log('[client] newPlayer', data);
    if (otherPlayers && !pendingOtherIds.has(data.id)) {
      addOtherPlayerDirect(thisSceneForAdd(), data.id, data.player);
    } else {
      // stash or ignore
      console.log('[client] newPlayer arrived but scene not ready yet');
    }
  });

  socket.on('playerMoved', (data) => {
    if (otherPlayers) {
      applyPlayerMovedDirect(thisSceneForAdd(), data);
    }
  });

  socket.on('playerDisconnected', (id) => {
    console.log('[client] playerDisconnected', id);
    if (otherPlayers) removeOtherPlayerByIdDirect(thisSceneForAdd(), id);
  });

  // now start Phaser
  startPhaser();
}

// small helper to get a reference to the current Phaser scene
let _lastScene = null;
function thisSceneForAdd() { return _lastScene; }

function startPhaser() {
  const config = {
    type: Phaser.AUTO,
    parent: 'game-container',
    scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH, width: window.innerWidth, height: window.innerHeight },
    physics: { default: 'arcade', arcade: { debug: false } },
    scene: { preload, create, update }
  };
  new Phaser.Game(config);
}

function preload() {
  this.load.image('officeMap', 'images/office_space_floor_001.png');
  this.load.spritesheet('playerAvatar', 'images/walkcyclevarious.png', { frameWidth: 64, frameHeight: 60 });
}

function create() {
  _lastScene = this; // allow socket handlers to reference the scene

  const map = this.add.image(0, 0, 'officeMap').setOrigin(0, 0);
  const texture = this.textures.get('officeMap');
  const mapWidth = texture.getSourceImage().width;
  const mapHeight = texture.getSourceImage().height;
  this.physics.world.setBounds(-70, 100, mapWidth + 130, mapHeight - 180);

  // create local player
  player = this.physics.add.sprite(400, 300, 'playerAvatar').setScale(4).setCollideWorldBounds(true);
  player.myAvatarRow = parseInt(sessionStorage.getItem('preferredAvatarRow') || '0', 10);
  player.setDepth(1);

  // local name label (will be replaced by server authoritative name)
  player.nameText = this.add.text(player.x, player.y + 90, sessionStorage.getItem('preferredName') || 'Anon', {
    fontSize: '16px', fontFamily: 'Arial', stroke: '#000', strokeThickness: 3
  }).setOrigin(0.5, 1).setDepth(2);

  otherPlayers = this.add.group();

  // create animations per row
// safer animation creation — determine available frames and use modulo to avoid out-of-range frames
const totalFrames = getPlayerAvatarFrameCount(this) || 12;
const FRAMES_PER_ROW = 12; // original assumption
for (let row = 0; row < TOTAL_AVATAR_ROWS; row++) {
  const base = row * FRAMES_PER_ROW;
  // create three-frame animations but clamp each frame index into available range
  const upFrames = [
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 0) },
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 1) },
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 2) }
  ];
  const rightFrames = [
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 3) },
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 4) },
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 5) }
  ];
  const downFrames = [
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 6) },
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 7) },
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 8) }
  ];
  const leftFrames = [
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 9) },
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 10) },
    { key: 'playerAvatar', frame: safeFrameIndex(this, base + 11) }
  ];

  this.anims.create({ key: `walk-up-${row}`, frames: upFrames, frameRate: 10, repeat: -1 });
  this.anims.create({ key: `walk-right-${row}`, frames: rightFrames, frameRate: 10, repeat: -1 });
  this.anims.create({ key: `walk-down-${row}`, frames: downFrames, frameRate: 10, repeat: -1 });
  this.anims.create({ key: `walk-left-${row}`, frames: leftFrames, frameRate: 10, repeat: -1 });
}

  this.cameras.main.setBounds(-70, 100, mapWidth + 130, mapHeight - 180);
  this.cameras.main.startFollow(player, false, 1, 1);
  this.cameras.main.roundPixels = true;
  this.scale.on('resize', (g) => this.cameras.resize(g.width, g.height));

  cursors = this.input.keyboard.createCursorKeys();

  // If server already sent currentPlayers (during connect step), that was stored in sessionStorage
  const initialPlayersRaw = sessionStorage.getItem('initialPlayers');
  if (initialPlayersRaw) {
    try {
      const players = JSON.parse(initialPlayersRaw);
      console.log('[client] applying initialPlayers from storage', players);
      handleCurrentPlayers(players);
      sessionStorage.removeItem('initialPlayers');
    } catch (e) {
      console.warn('[client] failed parsing initialPlayers', e);
    }
  }
}

function handleCurrentPlayers(players) {
  Object.keys(players).forEach((id) => {
    const p = players[id];
    if (id === socket.id) {
      // apply authoritative data to local player
      player.x = p.x; player.y = p.y;
      player.myAvatarRow = (p.avatarRow !== undefined) ? p.avatarRow : player.myAvatarRow;
      setSafeFrame(player, this, player.myAvatarRow * 12 + 7);
      if (player.nameText) player.nameText.setText(p.name || sessionStorage.getItem('preferredName') || 'Anon');
    } else {
      addOtherPlayerDirect(_lastScene, id, p);
    }
  });
}

function addOtherPlayerDirect(scene, id, p) {
  if (!scene) { console.warn('[client] scene not ready for addOtherPlayerDirect'); return; }
  if (!p) return;
  if (pendingOtherIds.has(id)) { console.log('[client] addOtherPlayerDirect skip duplicate', id); return; }
  pendingOtherIds.add(id);

  const other = scene.add.sprite(p.x, p.y, 'playerAvatar').setScale(4);
  scene.physics.add.existing(other, false);
  other.playerId = id;
  other.avatarRow = (p.avatarRow !== undefined) ? p.avatarRow : 0;
  other.setDepth(1);

  other.nameText = scene.add.text(p.x, p.y + 90, p.name || 'Anon', { fontSize: '16px', fontFamily: 'Arial', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(2);

  const off = other.avatarRow * 12;
  setSafeFrame(other, scene, off + 7);
  other.lastDirection = 'down';
  other.targetX = p.x; other.targetY = p.y;

  otherPlayers.add(other);
  console.log('[client] added other player', id, p);
}

function applyPlayerMovedDirect(scene, data) {
  if (!scene) return;
  const other = otherPlayers.getChildren().find(sp => sp.playerId === data.id);
  if (!other) return;
  if (data.avatarRow !== undefined) {
    other.avatarRow = data.avatarRow;
    const off = other.avatarRow * 12;
    if (!other.anims.isPlaying) other.setFrame(off + 7);
  }
  other.targetX = data.x; other.targetY = data.y;
  if (data.anim) { other.anims.play(data.anim, true); other.lastDirection = directionFromAnimKey(data.anim); }
  else if (data.frame !== undefined && data.frame !== null) { other.anims.stop(); other.setFrame(data.frame); other.lastDirection = directionFromFrameIndex(data.frame); }
  if (data.name && other.nameText) other.nameText.setText(data.name);
}

function removeOtherPlayerByIdDirect(scene, id) {
  if (!scene) return;
  const other = otherPlayers.getChildren().find(sp => sp.playerId === id);
  if (other) {
    if (other.nameText) other.nameText.destroy();
    other.destroy();
    pendingOtherIds.delete(id);
    console.log('[client] removed other player', id);
  }
}

function update() {
  if (!player) return;
  const speed = 250;
  player.setVelocity(0);

  if (cursors.left.isDown) { player.setVelocityX(-speed); player.anims.play(`walk-left-${player.myAvatarRow}`, true); lastDirection = 'left'; }
  else if (cursors.right.isDown) { player.setVelocityX(speed); player.anims.play(`walk-right-${player.myAvatarRow}`, true); lastDirection = 'right'; }
  else if (cursors.up.isDown) { player.setVelocityY(-speed); player.anims.play(`walk-up-${player.myAvatarRow}`, true); lastDirection = 'up'; }
  else if (cursors.down.isDown) { player.setVelocityY(speed); player.anims.play(`walk-down-${player.myAvatarRow}`, true); lastDirection = 'down'; }
  else {
    player.anims.stop();
    const off = player.myAvatarRow * 12;
    if (lastDirection === 'left') player.setFrame(off + 10);
    else if (lastDirection === 'right') player.setFrame(off + 4);
    else if (lastDirection === 'up') player.setFrame(off + 1);
    else player.setFrame(off + 7);
  }

  const frameVal = (() => {
    if (!player.frame) return null;
    return (typeof player.frame.index === 'number') ? player.frame.index : (typeof player.frame.name === 'number' ? player.frame.name : null);
  })();
  const animName = player.anims.currentAnim ? player.anims.currentAnim.key : null;
  if (socket && (player.x !== player.oldX || player.y !== player.oldY || animName !== player.oldAnim || frameVal !== player.oldFrame)) {
    socket.emit('playerMovement', { x: player.x, y: player.y, anim: animName, frame: frameVal });
    player.oldX = player.x; player.oldY = player.y; player.oldAnim = animName; player.oldFrame = frameVal;
  }

  // LERP remote players and update labels
  const REMOTE_LERP = 0.28, STOP_EPS = 1.6;
  if (otherPlayers) {
    otherPlayers.getChildren().forEach((other) => {
      if (typeof other.targetX === 'number' && typeof other.targetY === 'number') {
        other.x = Phaser.Math.Linear(other.x, other.targetX, REMOTE_LERP);
        other.y = Phaser.Math.Linear(other.y, other.targetY, REMOTE_LERP);

        const dx = Math.abs(other.x - other.targetX), dy = Math.abs(other.y - other.targetY);
        if (dx < STOP_EPS && dy < STOP_EPS) {
          if (other.anims && other.anims.isPlaying) {
            other.anims.stop();
            const off = (other.avatarRow ?? 0) * 12;
            const dir = other.lastDirection || 'down';
            if (dir === 'left') other.setFrame(off + 10);
            else if (dir === 'right') other.setFrame(off + 4);
            else if (dir === 'up') other.setFrame(off + 1);
            else other.setFrame(off + 7);
          }
        }

        if (other.nameText) { other.nameText.x = other.x; other.nameText.y = other.y + 90; }
      }
    });
  }

  if (player && player.nameText) { player.nameText.x = player.x; player.nameText.y = player.y + 90; }
}

function directionFromAnimKey(animKey) {
  if (!animKey) return 'down';
  const parts = animKey.split('-'); if (parts.length >= 2) return parts[1]; return 'down';
}
function directionFromFrameIndex(frameIndex) {
  if (typeof frameIndex !== 'number') return 'down';
  const idx = frameIndex % 12;
  if (idx <= 2) return 'up';
  if (idx >= 3 && idx <= 5) return 'right';
  if (idx >= 6 && idx <= 8) return 'down';
  return 'left';
}

// Helper: read actual number of frames available in the loaded atlas/spritessheet
function getPlayerAvatarFrameCount(scene) {
  try {
    const tex = scene.textures.get('playerAvatar');
    if (!tex) return 0;
    // frameTotal is available on the TextureSource? Fallback to frameNames
    const names = tex.getFrameNames ? tex.getFrameNames() : null;
    if (Array.isArray(names) && names.length) return names.length;
    // fallback: try to infer from base texture dimensions + frame size (if available)
    if (tex.source && tex.source[0] && tex.source[0].image) {
      // If we can't compute reliably, just return a sensible guard value
      return 96; // safe guess; will be used only if getFrameNames unavailable
    }
  } catch (e) {
    // ignore
  }
  return 0;
}

function safeFrameIndex(scene, idx) {
  const total = getPlayerAvatarFrameCount(scene) || 1;
  // ensure integer
  let i = Math.floor(Number(idx) || 0);
  // clamp into 0..total-1
  if (i < 0) i = 0;
  if (i >= total) i = i % total;
  return i;
}

// Use this whenever calling setFrame(...)
function setSafeFrame(sprite, scene, requestedIndex) {
  const safeIdx = safeFrameIndex(scene, requestedIndex);
  try {
    sprite.setFrame(safeIdx);
  } catch (e) {
    // if setFrame still fails for some reason, fallback to frame 0
    sprite.setFrame(0);
  }
}