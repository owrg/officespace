// game.js (fixed) - ready-to-drop
// Features: prejoin UI binding, connect-after-join, safe frame handling, player labels,
// chat input wiring, speech bubble rendering, spatial audio (WebRTC mesh)

const TOTAL_AVATAR_ROWS = 8;
let socket = null;
let player = null;
let otherPlayers = null;
let cursors = null;
let lastDirection = "down";
const pendingOtherIds = new Set();
let _lastScene = null;

// -------------------- Safe frame helpers --------------------
function getPlayerAvatarFrameCount(scene) {
  try {
    const tex = scene.textures.get("playerAvatar");
    if (!tex) return 0;
    if (typeof tex.getFrameNames === "function") {
      const names = tex.getFrameNames();
      if (Array.isArray(names) && names.length) return names.length;
    }
    // fallback guess
    return 96;
  } catch (e) {
    return 0;
  }
}

function safeFrameIndex(scene, idx) {
  const total = Math.max(1, getPlayerAvatarFrameCount(scene));
  let i = Math.floor(Number(idx) || 0);
  if (i < 0) i = 0;
  // modulo to wrap into valid range
  i = i % total;
  return i;
}

function setSafeFrame(sprite, scene, requestedIndex) {
  const safeIdx = safeFrameIndex(scene, requestedIndex);
  try {
    sprite.setFrame(safeIdx);
  } catch (e) {
    try {
      sprite.setFrame(0);
    } catch (e2) {
      /* swallow */
    }
  }
}

// -------------------- Prejoin UI binding --------------------
function createPrejoinUI() {
  // create only if missing (index.html might already include it)
  if (document.getElementById("prejoin")) return;
  const div = document.createElement("div");
  div.id = "prejoin";
  div.style =
    "position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999";
  div.innerHTML = `
    <div style="background:#fff;padding:18px;border-radius:8px;min-width:260px">
      <h1 style="margin:0 0 8px 0">Welcome to Office Space</h1>
      <h3 style="margin:0 0 8px 0">Enter name & character</h3>
      <input id="playerName" placeholder="Your name" style="width:100%;padding:6px;margin-bottom:8px" />
      <label style="display:block;margin-bottom:6px">Character</label>
      <select id="avatarSelect" style="width:100%;padding:6px;margin-bottom:12px">
        ${Array.from({ length: TOTAL_AVATAR_ROWS })
          .map((_, i) => `<option value="${i}">Character ${i + 1}</option>`)
          .join("")}
      </select>
      <button id="joinBtn" style="width:100%;padding:8px">Join</button>
    </div>
  `;
  document.body.appendChild(div);
}

// Ensure the Join button triggers the connection even if index.html supplied the DOM
function ensurePrejoinHandler() {
  const pre = document.getElementById("prejoin");
  const btn = document.getElementById("joinBtn");
  if (!btn || !pre) return;
  if (btn._hasPrejoinHandler) return;

  btn.addEventListener("click", () => {
    const name =
      (document.getElementById("playerName").value || "").trim() || "Anon";
    const avatarRow = parseInt(
      document.getElementById("avatarSelect").value || "0",
      10,
    );
    sessionStorage.setItem("preferredName", name);
    sessionStorage.setItem("preferredAvatarRow", avatarRow);
    pre.style.display = "none";

    if (typeof connectSocketAndStart === "function") {
      try {
        connectSocketAndStart(name, avatarRow);
      } catch (e) {
        console.error("connectSocketAndStart error", e);
      }
    } else if (window.socket && window.socket.connected) {
      window.socket.emit("join", { name, avatarRow });
    } else {
      // saved for later; Phaser will pick up when it starts
    }

    // Resume audio context on user gesture if needed. Spatial audio initialisation
    // runs after socket connect via startSpatialAudio().
    if (window.audioCtx && window.audioCtx.state === "suspended")
      window.audioCtx.resume().catch(() => {});
  });

  btn._hasPrejoinHandler = true;
}

// -------------------- Chat UI binding --------------------
function ensureChatHandlers() {
  const input = document.getElementById("chatInput");
  const send = document.getElementById("chatSend");
  if (!input || !send) {
    setTimeout(ensureChatHandlers, 50);
    return;
  }
  if (send._hasChatHandler) return;

  function attachInputFocusGuards(input) {
    // stop keyboard events reaching the game while typing
    const stop = (ev) => {
      // allow Enter to be handled by our handler below (we still stop propagation)
      ev.stopPropagation();
    };

    input.addEventListener("keydown", stop, { passive: false });
    input.addEventListener("keypress", stop, { passive: false });
    input.addEventListener("keyup", stop, { passive: false });

    // When focused, optionally disable Phaser keyboard handling so global key listeners don't fight
    input.addEventListener("focus", () => {
      try {
        if (
          window._lastScene &&
          window._lastScene.input &&
          window._lastScene.input.keyboard
        ) {
          window._lastScene.input.keyboard.enabled = false;
        }
      } catch (e) {
        /* ignore if not available */
      }
    });

    // On blur re-enable Phaser keyboard handling
    input.addEventListener("blur", () => {
      try {
        if (
          window._lastScene &&
          window._lastScene.input &&
          window._lastScene.input.keyboard
        ) {
          window._lastScene.input.keyboard.enabled = true;
        }
      } catch (e) {
        /* ignore if not available */
      }
    });
  }

  // call it inside ensureChatHandlers after input is found:
  attachInputFocusGuards(input);

  function sendText() {
    const txt = (input.value || "").trim();
    if (!txt) return;
    if (window.socket && window.socket.connected) {
      window.socket.emit("chat", { text: txt });
    } else {
      console.warn("socket not connected; chat not sent");
    }
    showLocalSpeech(txt);
    input.value = "";
    input.focus();
  }

  send.addEventListener("click", sendText);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      sendText();
    }
  });

  send._hasChatHandler = true;
}

// -------------------- Socket + Phaser lifecycle --------------------
function connectSocketAndStart(name, avatarRow) {
  console.log("[client] connectSocketAndStart", { name, avatarRow });
  const params = new URLSearchParams(window.location.search);
  const roomID = params.get("room") || "lobby";

  socket = window.socket = io({
    query: { room: roomID, name: name, avatarRow: avatarRow },
    transports: ["websocket"],
  });

  socket.on("connect", () => {
    console.log("[client] socket connected id=", socket.id);
    // start spatial audio once socket exists
    try { startSpatialAudio(); } catch (e) { console.warn('startSpatialAudio failed', e); }
  });
  socket.on("connect_error", (err) =>
    console.error("[client] connect_error", err),
  );

  socket.on("currentPlayers", (players) => {
    console.log("[client] currentPlayers", players);
    // if Phaser scene exists apply immediately, otherwise stash for create()
    if (_lastScene) handleCurrentPlayers(players);
    else sessionStorage.setItem("initialPlayers", JSON.stringify(players));
  });

  socket.on("newPlayer", (data) => {
    console.log("[client] newPlayer", data);
    if (_lastScene) addOtherPlayerDirect(_lastScene, data.id, data.player);
    else {
      // stash in sessionStorage? keep it simple: ignore until scene ready
      console.log(
        "[client] scene not ready for newPlayer; ignoring (will show when players move or on refresh)",
      );
    }
  });

  socket.on("playerMoved", (data) => {
    if (_lastScene) applyPlayerMovedDirect(_lastScene, data);
  });
  socket.on("playerDisconnected", (id) => {
    if (_lastScene) removeOtherPlayerByIdDirect(_lastScene, id);
  });

  // chat handler
  socket.on("chatMessage", (msg) => {
    // msg: { id, text, name }
    if (!_lastScene) {
      console.log("[client] chatMessage arrived but scene not ready", msg);
      return;
    }
    const targetId = msg.id;
    let targetSprite = null;
    if (targetId === socket.id) targetSprite = player;
    else {
      const arr = otherPlayers ? otherPlayers.getChildren() : [];
      targetSprite = arr.find((sp) => sp.playerId === targetId);
    }
    if (!targetSprite) {
      console.warn("chatMessage: target sprite not found for id", targetId);
      return;
    }
    showSpeechBubble(_lastScene, targetSprite, msg.text, { name: msg.name });
  });

  // start Phaser (if not already started)
  if (!_lastScene) startPhaser();
}

function startPhaser() {
  const config = {
    type: Phaser.AUTO,
    parent: "game-container",
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    physics: { default: "arcade", arcade: { debug: false } },
    scene: { preload, create, update },
  };
  new Phaser.Game(config);
}

// -------------------- Phaser scene functions --------------------
function preload() {
  this.load.image("officeMap", "images/office_space_floor_001.png");
  this.load.spritesheet("playerAvatar", "images/walkcyclevarious.png", {
    frameWidth: 64,
    frameHeight: 60,
  });
}

function create() {
  _lastScene = this;

  const map = this.add.image(0, 0, "officeMap").setOrigin(0, 0);
  const texture = this.textures.get("officeMap");
  const mapWidth = texture.getSourceImage().width;
  const mapHeight = texture.getSourceImage().height;
  this.physics.world.setBounds(-70, 100, mapWidth + 130, mapHeight - 180);

  // local player
  player = this.physics.add
    .sprite(400, 300, "playerAvatar")
    .setScale(4)
    .setCollideWorldBounds(true);
  player.myAvatarRow = parseInt(
    sessionStorage.getItem("preferredAvatarRow") || "0",
    10,
  );
  player.setDepth(1);

  // local name label (below sprite by default)
  const localName = sessionStorage.getItem("preferredName") || "Anon";
  player.nameText = this.add
    .text(player.x, player.y + 80, localName, {
      fontSize: "16px",
      fontFamily: "Arial",
      stroke: "#000",
      strokeThickness: 3,
    })
    .setOrigin(0.5, 0)
    .setDepth(2);

  otherPlayers = this.add.group();

  // create guarded animations
  const FRAMES_PER_ROW = 12;
  for (let row = 0; row < TOTAL_AVATAR_ROWS; row++) {
    const base = row * FRAMES_PER_ROW;
    const upFrames = [
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 0) },
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 1) },
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 2) },
    ];
    const rightFrames = [
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 3) },
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 4) },
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 5) },
    ];
    const downFrames = [
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 6) },
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 7) },
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 8) },
    ];
    const leftFrames = [
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 9) },
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 10) },
      { key: "playerAvatar", frame: safeFrameIndex(this, base + 11) },
    ];

    this.anims.create({
      key: `walk-up-${row}`,
      frames: upFrames,
      frameRate: 10,
      repeat: -1,
    });
    this.anims.create({
      key: `walk-right-${row}`,
      frames: rightFrames,
      frameRate: 10,
      repeat: -1,
    });
    this.anims.create({
      key: `walk-down-${row}`,
      frames: downFrames,
      frameRate: 10,
      repeat: -1,
    });
    this.anims.create({
      key: `walk-left-${row}`,
      frames: leftFrames,
      frameRate: 10,
      repeat: -1,
    });
  }

  this.cameras.main.setBounds(-70, 100, mapWidth + 130, mapHeight - 180);
  this.cameras.main.startFollow(player, false, 1, 1);
  this.cameras.main.roundPixels = true;
  this.scale.on("resize", (g) => this.cameras.resize(g.width, g.height));

  cursors = this.input.keyboard.createCursorKeys();

  // apply initial players (if server sent them during handshake)
  const initialPlayersRaw = sessionStorage.getItem("initialPlayers");
  if (initialPlayersRaw) {
    try {
      const players = JSON.parse(initialPlayersRaw);
      handleCurrentPlayers(players);
      sessionStorage.removeItem("initialPlayers");
    } catch (e) {
      console.warn("failed parsing initialPlayers", e);
    }
  }

  // wire DOM handlers that might be provided by index.html or created earlier
  ensurePrejoinHandler();
  ensureChatHandlers();
}

function update() {
  if (!player) return;
  const speed = 250;
  player.setVelocity(0);

  if (cursors.left.isDown) {
    player.setVelocityX(-speed);
    player.anims.play(`walk-left-${player.myAvatarRow}`, true);
    lastDirection = "left";
  } else if (cursors.right.isDown) {
    player.setVelocityX(speed);
    player.anims.play(`walk-right-${player.myAvatarRow}`, true);
    lastDirection = "right";
  } else if (cursors.up.isDown) {
    player.setVelocityY(-speed);
    player.anims.play(`walk-up-${player.myAvatarRow}`, true);
    lastDirection = "up";
  } else if (cursors.down.isDown) {
    player.setVelocityY(speed);
    player.anims.play(`walk-down-${player.myAvatarRow}`, true);
    lastDirection = "down";
  } else {
    player.anims.stop();
    const off = player.myAvatarRow * 12;
    if (lastDirection === "left") setSafeFrame(player, _lastScene, off + 10);
    else if (lastDirection === "right")
      setSafeFrame(player, _lastScene, off + 4);
    else if (lastDirection === "up") setSafeFrame(player, _lastScene, off + 1);
    else setSafeFrame(player, _lastScene, off + 7);
  }

  // send movement updates on change
  const frameVal = (() => {
    if (!player.frame) return null;
    return typeof player.frame.index === "number"
      ? player.frame.index
      : typeof player.frame.name === "number"
        ? player.frame.name
        : null;
  })();
  const animName = player.anims.currentAnim
    ? player.anims.currentAnim.key
    : null;
  if (
    socket &&
    (player.x !== player.oldX ||
      player.y !== player.oldY ||
      animName !== player.oldAnim ||
      frameVal !== player.oldFrame)
  ) {
    socket.emit("playerMovement", {
      x: player.x,
      y: player.y,
      anim: animName,
      frame: frameVal,
    });
    player.oldX = player.x;
    player.oldY = player.y;
    player.oldAnim = animName;
    player.oldFrame = frameVal;
  }

  // LERP remote players and update labels
  const REMOTE_LERP = 0.28,
    STOP_EPS = 1.6;
  otherPlayers.getChildren().forEach((other) => {
    if (
      typeof other.targetX === "number" &&
      typeof other.targetY === "number"
    ) {
      other.x = Phaser.Math.Linear(other.x, other.targetX, REMOTE_LERP);
      other.y = Phaser.Math.Linear(other.y, other.targetY, REMOTE_LERP);

      const dx = Math.abs(other.x - other.targetX),
        dy = Math.abs(other.y - other.targetY);
      if (dx < STOP_EPS && dy < STOP_EPS) {
        if (other.anims && other.anims.isPlaying) {
          other.anims.stop();
          const off = (other.avatarRow ?? 0) * 12;
          const dir = other.lastDirection || "down";
          if (dir === "left") setSafeFrame(other, _lastScene, off + 10);
          else if (dir === "right") setSafeFrame(other, _lastScene, off + 4);
          else if (dir === "up") setSafeFrame(other, _lastScene, off + 1);
          else setSafeFrame(other, _lastScene, off + 7);
        }
      }

      if (other.nameText) {
        other.nameText.x = other.x;
        other.nameText.y = other.y + 80;
      }
    }
  });

  if (player.nameText) {
    player.nameText.x = player.x;
    player.nameText.y = player.y + 80;
  }

  // update spatial audio panners/listener each frame
  try {
    updateSpatialPositions();
  } catch (e) {
    // be resilient in case audio system not initialized yet
  }
}

// -------------------- Player management helpers --------------------
function handleCurrentPlayers(players) {
  Object.keys(players).forEach((id) => {
    const p = players[id];
    if (id === socket.id) {
      player.x = p.x;
      player.y = p.y;
      player.myAvatarRow =
        p.avatarRow !== undefined ? p.avatarRow : player.myAvatarRow;
      setSafeFrame(player, _lastScene, player.myAvatarRow * 12 + 7);
      if (player.nameText)
        player.nameText.setText(
          p.name || sessionStorage.getItem("preferredName") || "Anon",
        );
    } else {
      addOtherPlayerDirect(_lastScene, id, p);
    }
  });
}

function addOtherPlayerDirect(scene, id, p) {
  if (!scene || !p) return;
  if (pendingOtherIds.has(id)) return;
  pendingOtherIds.add(id);

  const other = scene.add.sprite(p.x, p.y, "playerAvatar").setScale(4);
  scene.physics.add.existing(other, false);
  other.playerId = id;
  other.avatarRow = p.avatarRow !== undefined ? p.avatarRow : 0;
  other.setDepth(1);

  other.nameText = scene.add
    .text(p.x, p.y + 80, p.name || "Anon", {
      fontSize: "16px",
      fontFamily: "Arial",
      stroke: "#000",
      strokeThickness: 3,
    })
    .setOrigin(0.5, 0)
    .setDepth(2);

  const off = other.avatarRow * 12;
  setSafeFrame(other, scene, off + 7);
  other.lastDirection = "down";
  other.targetX = p.x;
  other.targetY = p.y;

  otherPlayers.add(other);
  console.log("[client] added other player", id, p);
}

function applyPlayerMovedDirect(scene, data) {
  if (!scene) return;
  const other = otherPlayers
    .getChildren()
    .find((sp) => sp.playerId === data.id);
  if (!other) return;
  if (data.avatarRow !== undefined) {
    other.avatarRow = data.avatarRow;
    const off = other.avatarRow * 12;
    if (!other.anims.isPlaying) setSafeFrame(other, scene, off + 7);
  }
  other.targetX = data.x;
  other.targetY = data.y;
  if (data.anim) {
    other.anims.play(data.anim, true);
    other.lastDirection = directionFromAnimKey(data.anim);
  } else if (data.frame !== undefined && data.frame !== null) {
    other.anims.stop();
    setSafeFrame(other, scene, data.frame);
    other.lastDirection = directionFromFrameIndex(data.frame);
  }
  if (data.name && other.nameText) other.nameText.setText(data.name);
}

function removeOtherPlayerByIdDirect(scene, id) {
  if (!scene) return;
  const other = otherPlayers.getChildren().find((sp) => sp.playerId === id);
  if (other) {
    if (other.nameText) other.nameText.destroy();
    other.destroy();
    pendingOtherIds.delete(id);
    console.log("[client] removed other player", id);
  }
}

// -------------------- helpers --------------------
function directionFromAnimKey(animKey) {
  if (!animKey) return "down";
  const parts = animKey.split("-");
  if (parts.length >= 2) return parts[1];
  return "down";
}
function directionFromFrameIndex(frameIndex) {
  if (typeof frameIndex !== "number") return "down";
  const idx = frameIndex % 12;
  if (idx <= 2) return "up";
  if (idx >= 3 && idx <= 5) return "right";
  if (idx >= 6 && idx <= 8) return "down";
  return "left";
}

// -------------------- Speech bubble UI --------------------
function showSpeechBubble(scene, sprite, text, opts = {}) {
  if (!scene || !sprite) return;
  const PADDING_X = 10,
    PADDING_Y = 6,
    MAX_WIDTH = 200,
    LIFETIME = 3500,
    OFFSET_Y = -120;
  const style = {
    fontSize: "14px",
    fontFamily: "Arial",
    color: "#000",
    align: "center",
    wordWrap: { width: MAX_WIDTH },
  };
  const bubbleText = scene.add.text(0, 0, text, style).setOrigin(0.5, 0);
  let nameText = null;
  if (opts.name)
    nameText = scene.add
      .text(0, 0, opts.name, {
        fontSize: "11px",
        fontFamily: "Arial",
        color: "#222",
        align: "center",
      })
      .setOrigin(0.5, 1);

  const tw = bubbleText.width + PADDING_X * 2;
  const th = bubbleText.height + PADDING_Y * 2 + (nameText ? 14 : 0);
  const bg = scene.add.graphics();
  const radius = 8;
  bg.fillStyle(0xffffff, 1);
  bg.fillRoundedRect(-tw / 2, 0, tw, th, radius);
  bg.fillTriangle(-8, th, 8, th, 0, th + 10);
  bg.lineStyle(2, 0x333333, 1);
  bg.strokeRoundedRect(-tw / 2, 0, tw, th, radius);

  const container = scene.add.container(sprite.x, sprite.y + OFFSET_Y, [
    bg,
    bubbleText,
  ]);
  if (nameText) {
    nameText.x = 0;
    nameText.y = -14;
    container.add(nameText);
  }
  bubbleText.x = 0;
  bubbleText.y = nameText ? 6 : 6;
  container.setDepth(1000);

  const updateFn = () => {
    if (!sprite.scene || !container) return;
    container.x = sprite.x;
    container.y = sprite.y + OFFSET_Y;
  };
  scene.events.on("update", updateFn);

  scene.tweens.add({
    targets: container,
    alpha: { from: 1, to: 0 },
    ease: "Cubic.easeIn",
    delay: LIFETIME,
    duration: 500,
    onComplete: () => {
      scene.events.off("update", updateFn);
      container.destroy(true);
      bg.destroy();
      bubbleText.destroy();
      if (nameText) nameText.destroy();
    },
  });

  return container;
}

function showLocalSpeech(text) {
  if (!player || !_lastScene) {
    console.warn("showLocalSpeech: player or scene missing");
    return;
  }
  showSpeechBubble(_lastScene, player, text, {
    name: sessionStorage.getItem("preferredName") || "You",
  });
}

// -------------------- Init: attach DOM handlers and possibly auto-fill fields --------------------
document.addEventListener("DOMContentLoaded", () => {
  // create prejoin UI only if missing
  createPrejoinUI();
  ensurePrejoinHandler();
  ensureChatHandlers();

  // if stored values exist, prefill fields
  const preName = sessionStorage.getItem("preferredName");
  const preRow = sessionStorage.getItem("preferredAvatarRow");
  if (preName) {
    const nameInput = document.getElementById("playerName");
    const avatarSelect = document.getElementById("avatarSelect");
    if (nameInput) nameInput.value = preName;
    if (avatarSelect) avatarSelect.value = preRow || "0";
  }

  // If user previously joined (sessionStorage), connect automatically
  const autoName = sessionStorage.getItem("preferredName");
  const autoRow = parseInt(
    sessionStorage.getItem("preferredAvatarRow") || "0",
    10,
  );
  if (autoName && typeof connectSocketAndStart === "function") {
    // subtle delay to allow socket.io client script to be ready in page environment
    setTimeout(() => {
      try {
        connectSocketAndStart(autoName, autoRow);
      } catch (e) {
        /* ignore */
      }
    }, 60);
  }
});

// ---------------- Spatial audio (mesh WebRTC) ----------------

// STUN servers (replace/add TURN for production)
const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

// maps peerId => { pc, stream, panner, gain, audioElem }
const peerAudio = {};

// AudioContext (one per page)
let audioCtx = null;

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // expose globally for small user-gesture resume attempts from other code
    window.audioCtx = audioCtx;
  }
  return audioCtx;
}

// convert game (x,y) into 3D audio coordinates (meters)
// tweak scaleFactor to control audible distance
function mapGameTo3DPosition(x, y) {
  // Choose coordinate mapping: x -> x, y -> z (forward), y-axis (height) = 0
  const scaleFactor = 0.02; // pixels -> meters (tweak experimentally)
  const px = x * scaleFactor;
  const pz = y * scaleFactor;
  const py = 0; // ground level
  return { x: px, y: py, z: pz };
}

// Create audio nodes for a remote stream
function attachRemoteStreamToSpatialAudio(peerId, stream) {
  const scene = _lastScene;
  if (!scene) return;
  ensureAudioContext();

  // avoid attaching twice
  if (peerAudio[peerId] && peerAudio[peerId].attached) return;

  // create nodes
  const source = audioCtx.createMediaStreamSource(stream);
  const panner = audioCtx.createPanner();
  panner.panningModel = "HRTF";
  panner.distanceModel = "inverse";
  panner.refDistance = 0.5;
  panner.maxDistance = 50;
  panner.rolloffFactor = 1.0;
  // set orientation so "forward" is -z per WebAudio (but we'll keep default)
  try {
    if (typeof panner.positionX !== 'undefined') {
      panner.positionX.setValueAtTime(0, audioCtx.currentTime);
      panner.positionY.setValueAtTime(0, audioCtx.currentTime);
      panner.positionZ.setValueAtTime(0, audioCtx.currentTime);
    } else {
      panner.setPosition(0, 0, 0);
    }
  } catch (e) {
    /* older browsers */
  }

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = 1.0;

  source.connect(panner);
  panner.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  peerAudio[peerId] = peerAudio[peerId] || {};
  peerAudio[peerId].pcStream = stream;
  peerAudio[peerId].panner = panner;
  peerAudio[peerId].gain = gainNode;
  peerAudio[peerId].attached = true;

  console.log("[spatial] attached remote stream for", peerId);
}

// Update all remote panners based on positions from your game state
function updateSpatialPositions() {
  if (!audioCtx) return;
  const listener = audioCtx.listener;
  if (!listener) return;

  // Set listener position = local player position mapped to 3D coords
  if (player) {
    const lp = mapGameTo3DPosition(player.x, player.y);
    try {
      if (typeof listener.positionX !== 'undefined') {
        // modern API
        listener.positionX.setValueAtTime(lp.x, audioCtx.currentTime);
        listener.positionY.setValueAtTime(lp.y, audioCtx.currentTime);
        listener.positionZ.setValueAtTime(lp.z, audioCtx.currentTime);
      } else {
        listener.setPosition(lp.x, lp.y, lp.z);
      }
    } catch (e) {}
  }

  // update each remote peer's panner position to follow its sprite
  if (otherPlayers) {
    otherPlayers.getChildren().forEach((sp) => {
      const id = sp.playerId;
      const audio = peerAudio[id];
      if (!audio || !audio.panner) return;
      const pos = mapGameTo3DPosition(sp.x, sp.y);
      try {
        if (typeof audio.panner.positionX !== 'undefined') {
          audio.panner.positionX.setValueAtTime(pos.x, audioCtx.currentTime);
          audio.panner.positionY.setValueAtTime(pos.y, audioCtx.currentTime);
          audio.panner.positionZ.setValueAtTime(pos.z, audioCtx.currentTime);
        } else {
          audio.panner.setPosition(pos.x, pos.y, pos.z);
        }
      } catch (e) {
        // older API fallback
        try {
          audio.panner.setPosition(pos.x, pos.y, pos.z);
        } catch (e2) {}
      }

      // Optionally scale gain with distance as secondary safeguard
      if (player && audio.gain) {
        const dx = player.x - sp.x;
        const dy = player.y - sp.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // adjust gain curve (pixels -> coefficient)
        const maxAudible = 600; // pixels
        const g = Math.max(0, 1 - dist / maxAudible);
        audio.gain.gain.setValueAtTime(g, audioCtx.currentTime);
      }
    });
  }
}

// ---------------- WebRTC peer connection management ----------------

const peerConnections = {}; // peerId => RTCPeerConnection
let localStream = null;

// Create or reuse local microphone stream
async function ensureLocalAudio() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    // keep tracks quiet by default if you want, otherwise send microphone to peers
    console.log("[spatial] got local microphone stream");
    return localStream;
  } catch (err) {
    console.error("[spatial] microphone access denied or error", err);
    throw err;
  }
}

// create a new RTCPeerConnection for each peer
function createPeerConnection(peerId, initiator = false) {
  if (peerConnections[peerId]) return peerConnections[peerId];

  const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
  peerConnections[peerId] = pc;

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      socket.emit("webrtc-ice", { to: peerId, candidate: ev.candidate });
    }
  };

  // handle remote tracks
  pc.ontrack = (ev) => {
    console.log("[spatial] ontrack from", peerId, ev.streams);
    const remoteStream = ev.streams && ev.streams[0];
    if (remoteStream) {
      attachRemoteStreamToSpatialAudio(peerId, remoteStream);
    }
  };

  // optional: when connection state changes
  pc.onconnectionstatechange = () => {
    console.log("[spatial] pc state", peerId, pc.connectionState);
    if (
      pc.connectionState === "failed" ||
      pc.connectionState === "disconnected" ||
      pc.connectionState === "closed"
    ) {
      // cleanup
      if (peerAudio[peerId]) {
        try {
          peerAudio[peerId].gain.disconnect();
        } catch (e) {}
        delete peerAudio[peerId];
      }
      try {
        pc.close();
      } catch (e) {}
      delete peerConnections[peerId];
    }
  };

  return pc;
}

// Initiate P2P with a given peer (as the offerer)
async function initiatePeerConnection(peerId) {
  await ensureLocalAudio();
  const pc = createPeerConnection(peerId, true);

  // add local audio tracks
  localStream
    .getAudioTracks()
    .forEach((track) => pc.addTrack(track, localStream));

  // create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit("webrtc-offer", { to: peerId, sdp: pc.localDescription });
}

// Handle incoming offer: create answer
async function handleIncomingOffer(fromId, sdp) {
  await ensureLocalAudio();
  const pc = createPeerConnection(fromId, false);

  // add local tracks so we send audio back
  localStream
    .getAudioTracks()
    .forEach((track) => pc.addTrack(track, localStream));

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit("webrtc-answer", { to: fromId, sdp: pc.localDescription });
}

// Handle incoming answer (for initiator)
async function handleIncomingAnswer(fromId, sdp) {
  const pc = peerConnections[fromId];
  if (!pc) {
    console.warn("no pc for answer from", fromId);
    return;
  }
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

// Handle incoming ICE candidate
async function handleRemoteIce(fromId, candidate) {
  const pc = peerConnections[fromId];
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.warn("addIceCandidate failed", e);
  }
}

// Register socket signaling handlers (call after socket connected)
function setupSpatialSignaling() {
  if (!socket) {
    console.warn("socket missing for spatial signaling");
    return;
  }

  // When new peer joins, decide offerer/answerer side; we will let existing clients be offerers to new client.
  socket.on("webrtc-peer-joined", ({ id }) => {
    // if this event is for me, ignore
    if (!id || id === socket.id) return;
    console.log(
      "[spatial] peer joined",
      id,
      "— initiating connection (offerer)",
    );
    // Initiator: create offer to new peer
    initiatePeerConnection(id).catch(console.error);
  });

  socket.on("webrtc-offer", async ({ from, sdp }) => {
    if (!from || from === socket.id) return;
    console.log("[spatial] received offer from", from);
    await handleIncomingOffer(from, sdp);
  });

  socket.on("webrtc-answer", async ({ from, sdp }) => {
    if (!from || from === socket.id) return;
    console.log("[spatial] received answer from", from);
    await handleIncomingAnswer(from, sdp);
  });

  socket.on("webrtc-ice", async ({ from, candidate }) => {
    if (!from || from === socket.id) return;
    await handleRemoteIce(from, candidate);
  });

  // If you connect mid-room: ask others to prepare (they will get 'webrtc-peer-joined')
  socket.emit("webrtc-join");
}

// call this once when socket is available (e.g. in connectSocketAndStart after socket created)
function startSpatialAudio() {
  ensureAudioContext();
  setupSpatialSignaling();
  // optionally, resume audio context on user gesture
  if (audioCtx && audioCtx.state === "suspended") {
    const resume = () => {
      audioCtx.resume().catch(() => {});
      document.removeEventListener("click", resume);
    };
    document.addEventListener("click", resume);
  }
}