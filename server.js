// server.js — includes chat broadcast + debug logs (patched socket.room)
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
app.use(express.static("public"));
app.get("/favicon.ico", (req, res) => res.status(204).end());

let players = {};
let nextAvatarRow = 0;
const TOTAL_AVATAR_ROWS = 8;

function safeName(name) {
  if (typeof name === "string" && name.trim()) return name.trim().slice(0, 40);
  return "Anon";
}

io.on("connection", (socket) => {
  const room =
    (socket.handshake &&
      socket.handshake.query &&
      socket.handshake.query.room) ||
    "lobby";
  console.log(
    `[server] connection: socket.id=${socket.id}, handshakeQuery=`,
    socket.handshake && socket.handshake.query,
  );

  // join socket.io room and store it on the socket for later use in signaling
  socket.join(room);
  socket.room = room; // <-- important: ensure signaling uses correct room

  // Auto-create player if handshake includes name/avatarRow
  const hq = socket.handshake && socket.handshake.query;
  if (hq && (hq.name || hq.avatarRow !== undefined)) {
    const requestedRow =
      hq.avatarRow !== undefined ? parseInt(hq.avatarRow, 10) : undefined;
    const assignedRow =
      typeof requestedRow === "number" &&
      requestedRow >= 0 &&
      requestedRow < TOTAL_AVATAR_ROWS
        ? requestedRow
        : nextAvatarRow;
    if (
      requestedRow === undefined ||
      !(requestedRow >= 0 && requestedRow < TOTAL_AVATAR_ROWS)
    ) {
      nextAvatarRow = (nextAvatarRow + 1) % TOTAL_AVATAR_ROWS;
    }
    players[socket.id] = {
      x: 100,
      y: 100,
      room: room,
      avatarRow: assignedRow,
      anim: null,
      frame: null,
      name: safeName(hq.name),
    };
    console.log(
      `[server] auto-joined player for socket ${socket.id}:`,
      players[socket.id],
    );

    // emit currentPlayers snapshot
    const playersInRoom = {};
    Object.keys(players).forEach((id) => {
      if (players[id].room === room) playersInRoom[id] = players[id];
    });
    socket.emit("currentPlayers", playersInRoom);
    socket
      .to(room)
      .emit("newPlayer", { id: socket.id, player: players[socket.id] });
  }

  // fallback explicit join event
  socket.on("join", ({ name, avatarRow }) => {
    console.log(`[server] join from ${socket.id}:`, { name, avatarRow });
    if (players[socket.id]) {
      console.log("[server] join ignored, player exists for", socket.id);
      return;
    }
    const requestedRow = typeof avatarRow === "number" ? avatarRow : undefined;
    const assignedRow =
      typeof requestedRow === "number" &&
      requestedRow >= 0 &&
      requestedRow < TOTAL_AVATAR_ROWS
        ? requestedRow
        : nextAvatarRow;
    if (
      requestedRow === undefined ||
      !(requestedRow >= 0 && requestedRow < TOTAL_AVATAR_ROWS)
    ) {
      nextAvatarRow = (nextAvatarRow + 1) % TOTAL_AVATAR_ROWS;
    }
    players[socket.id] = {
      x: 100,
      y: 100,
      room: room,
      avatarRow: assignedRow,
      anim: null,
      frame: null,
      name: safeName(name),
    };
    const playersInRoom = {};
    Object.keys(players).forEach((id) => {
      if (players[id].room === room) playersInRoom[id] = players[id];
    });
    socket.emit("currentPlayers", playersInRoom);
    socket
      .to(room)
      .emit("newPlayer", { id: socket.id, player: players[socket.id] });
    console.log(`[server] join handled: ${socket.id} =>`, players[socket.id]);
  });

  // movement
  socket.on("playerMovement", (movementData) => {
    if (!players[socket.id]) return;
    players[socket.id].x = movementData.x;
    players[socket.id].y = movementData.y;
    players[socket.id].anim = movementData.anim || null;
    players[socket.id].frame =
      movementData.frame !== undefined ? movementData.frame : null;

    socket.to(players[socket.id].room).emit("playerMoved", {
      id: socket.id,
      x: players[socket.id].x,
      y: players[socket.id].y,
      anim: players[socket.id].anim,
      frame: players[socket.id].frame,
      avatarRow: players[socket.id].avatarRow,
      name: players[socket.id].name,
    });
  });

  // ----- CHAT: receive from client and broadcast to everyone in same room -----
  socket.on("chat", (payload) => {
    try {
      // ensure player exists and payload has text
      if (!players[socket.id]) {
        console.warn("[server] chat from unknown player", socket.id);
        return;
      }
      const text = String((payload && payload.text) || "")
        .slice(0, 400)
        .trim();
      if (!text) return;
      const roomName = players[socket.id].room || room;
      const msg = {
        id: socket.id,
        text: text,
        name: players[socket.id].name || "Anon",
      };
      // broadcast to room (including sender)
      io.to(roomName).emit("chatMessage", msg);
      console.log("[server] chat", msg);
    } catch (e) {
      console.error("[server] chat handler error", e);
    }
  });

  // signaling: tell existing peers about me (new client asks to prepare)
  socket.on("webrtc-join", () => {
    // notify everyone (except me) that I exist and they should prepare a connection
    // they can respond by calling create offer/answer
    socket.to(socket.room || "lobby").emit("webrtc-peer-joined", { id: socket.id });
  });

  // P2P signaling messages
  socket.on("webrtc-offer", ({ to, sdp }) => {
    if (!to) return;
    io.to(to).emit("webrtc-offer", { from: socket.id, sdp });
  });

  socket.on("webrtc-answer", ({ to, sdp }) => {
    if (!to) return;
    io.to(to).emit("webrtc-answer", { from: socket.id, sdp });
  });

  socket.on("webrtc-ice", ({ to, candidate }) => {
    if (!to) return;
    io.to(to).emit("webrtc-ice", { from: socket.id, candidate });
  });

  socket.on("disconnect", () => {
    console.log("[server] disconnect", socket.id);
    const r = players[socket.id] ? players[socket.id].room : null;
    delete players[socket.id];
    if (r) io.to(r).emit("playerDisconnected", socket.id);
  });
});

http.listen(3000, () => console.log("Server running on port 3000"));