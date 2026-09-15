const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('socket.io');

function createRelay() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
    if (!['/', '/neon-wick-room36.html'].includes(req.url?.split('?')[0])) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(__dirname, 'neon-wick-room36.html')).pipe(res);
  });
  const origins = process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim());
  const io = new Server(server, {
    cors: { origin: origins || '*' },
    allowRequest: (req, done) => done(null, !origins || !req.headers.origin || origins.includes(req.headers.origin)),
    maxHttpBufferSize: 1024 * 1024,
  });
  const rooms = new Map();
  io.on('connection', socket => {
    const { roomCode } = socket.handshake.auth;
    if (roomCode) {
      if (!/^nw-[a-f0-9]{16}$/.test(roomCode) || rooms.has(roomCode) || rooms.size >= 500) {
        socket.emit('relay-error', { type: 'room-unavailable', message: '房间码不可用，请重新创建' });
        return;
      }
      rooms.set(roomCode, { host: socket, guests: new Map() });
      socket.data.host = true; socket.data.room = roomCode;
    }
    socket.emit('registered', { id: roomCode || socket.id });
    socket.on('join-room', code => {
      if (socket.data.room) return;
      const room = typeof code === 'string' && rooms.get(code);
      if (!room || room.guests.size >= 7) {
        socket.emit('relay-error', { type: room ? 'room-full' : 'room-not-found', message: room ? '房间已满' : '房间不存在或房主已退出' }); return;
      }
      socket.data.room = code; room.guests.set(socket.id, socket);
      room.host.emit('channel-open', socket.id);
      socket.emit('channel-open', code);
    });
    socket.on('relay', packet => {
      const room = rooms.get(socket.data.room);
      if (!room || !packet || typeof packet !== 'object') return;
      // Route by server-owned room membership, never by caller-supplied sender IDs.
      const target = socket.data.host ? room.guests.get(packet.target) : packet.target === socket.data.room ? room.host : null;
      const type = packet.message?.type;
      if (!target || !(socket.data.host ? ['map', 'snapshot', 'reject'] : ['join', 'input', 'leave']).includes(type)) return;
      const now = Date.now();
      if (!socket.data.window || now - socket.data.window > 1000) { socket.data.window = now; socket.data.count = 0; }
      if (++socket.data.count > 500) return;
      target.emit('relay', { from: socket.data.host ? socket.data.room : socket.id, message: packet.message });
    });
    socket.on('close-channel', target => {
      const room = rooms.get(socket.data.room);
      if (socket.data.host && room) room.guests.get(target)?.disconnect(true);
      else socket.disconnect(true);
    });
    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.room);
      if (!room) return;
      if (socket.data.host) {
        rooms.delete(socket.data.room);
        for (const guest of room.guests.values()) { guest.emit('channel-close', socket.data.room); guest.disconnect(true); }
      } else {
        room.guests.delete(socket.id); room.host.emit('channel-close', socket.id);
      }
    });
  });
  return { server, io, rooms };
}
if (require.main === module) {
  const { server } = createRelay();
  server.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log(`Neon Wick: http://localhost:${server.address().port}`));
}
module.exports = { createRelay };
