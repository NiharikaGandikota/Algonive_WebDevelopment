const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));
const PORT = process.env.PORT || 3000;
/* ---------------- In-memory store (no DB) ---------------- */
const usersById = new Map();            // id -> { id, username, socketId }
const usersByName = new Map();          // username(lower) -> id
const sockets = new Map();              // socketId -> userId
const GENERAL = "room:general";
const rooms = new Map([
  [GENERAL, { id: GENERAL, name: "General", isDM: false, members: new Set() }]
]);
const roomMessages = new Map();         // roomId -> [msg]
function keep(roomId, msg) {
  if (!roomMessages.has(roomId)) roomMessages.set(roomId, []);
  const arr = roomMessages.get(roomId);
  arr.push(msg);
  if (arr.length > 300) arr.shift(); // keep last 300
}
const uid = (p="id") => `${p}_${Math.random().toString(36).slice(2,10)}`;
const dmId = (a,b) => {
  const [x,y] = [String(a), String(b)].sort();
  return `dm:${x}:${y}`;
};
const otherInDM = (rid, me) => {
  const [,a,b] = rid.split(":");
  return a === String(me) ? b : a;
};
function broadcastUsers() {
  const payload = [...usersById.values()].map(u => ({ id: u.id, username: u.username }));
  io.emit("users:list", payload);
}
/* ---------------- Socket.IO ---------------- */
io.on("connection", (socket) => {
  // LOGIN
  socket.on("auth:login", ({ username }, cb) => {
    const name = String(username||"").trim().toLowerCase();
    if (!name) return cb?.({ error: "Username required" });
    if (usersByName.has(name)) return cb?.({ error: "Username already in use" });

    const id = uid("usr");
    const user = { id, username: name, socketId: socket.id };
    usersById.set(id, user);
    usersByName.set(name, id);
    sockets.set(socket.id, id);
    // Join General by default
    rooms.get(GENERAL).members.add(id);
    socket.join(GENERAL);
    cb?.({
      ok: true,
      me: { id, username: name },
      rooms: [{ id: GENERAL, name: "General" }],
      people: [...usersById.values()]
        .filter(u => u.id !== id)
        .map(u => ({ id: u.id, username: u.username })),
      history: roomMessages.get(GENERAL) || []
    });
    io.to(GENERAL).emit("presence:join", { roomId: GENERAL, userId: id, username: name });
    broadcastUsers();
  });
  // OPEN DM
  socket.on("dm:open", ({ toUserId }, cb) => {
    const me = sockets.get(socket.id);
    if (!me || !usersById.has(toUserId)) return cb?.({ error: "User not found" });
    const rid = dmId(me, toUserId);
    if (!rooms.has(rid)) rooms.set(rid, { id: rid, name: "DM", isDM: true, members: new Set([me, toUserId]) });
    else {
      rooms.get(rid).members.add(me);
      rooms.get(rid).members.add(toUserId);
    }
    socket.join(rid);
    cb?.({ ok: true, roomId: rid, history: roomMessages.get(rid) || [] });
  });
  // JOIN public room (we only keep General here)
  socket.on("room:join", ({ roomId }) => {
    const me = sockets.get(socket.id);
    if (!me || !rooms.has(roomId)) return;
    rooms.get(roomId).members.add(me);
    socket.join(roomId);
    io.to(roomId).emit("presence:join", { roomId, userId: me, username: usersById.get(me).username });
  });
  // SEND MESSAGE
  socket.on("msg:send", ({ roomId, toUserId, text }, cb) => {
    const me = sockets.get(socket.id);
    if (!me) return cb?.({ error: "Not logged in" });
    let target = roomId;
    if (!target && toUserId) target = dmId(me, toUserId);
    if (!target) return cb?.({ error: "roomId or toUserId required" });
    const msg = {
      id: uid("msg"),
      roomId: target,
      from: me,
      text: String(text||"").slice(0, 3000),
      ts: Date.now()
    };
    keep(target, msg);
    io.to(target).emit("msg:new", msg);                   // deliver to all in room
    io.to(socket.id).emit("msg:delivered", { id: msg.id }); // sender sees ✓✓
    cb?.({ ok: true, id: msg.id, ts: msg.ts });
  });
  // TYPING
  socket.on("typing", ({ roomId, toUserId, isTyping }) => {
    const me = sockets.get(socket.id);
    if (!me) return;
    let target = roomId;
    if (!target && toUserId) target = dmId(me, toUserId);
    if (!target) return;
    socket.to(target).emit("typing", {
      roomId: target,
      userId: me,
      username: usersById.get(me)?.username,
      isTyping: !!isTyping
    });
  });
  // SEEN (read receipt)
  socket.on("msg:seen", ({ roomId, msgId }) => {
    const arr = roomMessages.get(roomId);
    const msg = arr?.find(m => m.id === msgId);
    if (!msg) return;
    const sender = usersById.get(msg.from);
    if (sender?.socketId) io.to(sender.socketId).emit("msg:seen", { id: msgId });
  });
  // DISCONNECT
  socket.on("disconnect", () => {
    const me = sockets.get(socket.id);
    if (!me) return;
    const name = usersById.get(me)?.username;
    sockets.delete(socket.id);
    usersById.delete(me);
    if (name) usersByName.delete(name);
    for (const r of rooms.values()) r.members?.delete?.(me);
    io.emit("presence:leave", { userId: me, username: name });
    broadcastUsers();
  });
});
server.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
