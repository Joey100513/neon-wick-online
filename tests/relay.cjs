const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { io } = require('socket.io-client');
const { createRelay } = require('../server.cjs');
const html = fs.readFileSync(require('node:path').join(__dirname, '../neon-wick-room36.html'), 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
assert.ok(!html.includes('peerjs'));
assert.ok(!html.includes('new Peer('));
const scope = vm.createContext({ window: { io } });
vm.runInContext(html.slice(html.indexOf('  class RelayEvents'), html.indexOf('  function netSend')) + '\nthis.Client = RelayClient;', scope);
const once = (emitter, name, accept = () => true) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Timeout: ' + name)), 3000);
  emitter.on(name, value => { if (accept(value)) { clearTimeout(timer); resolve(value); } });
});
async function run() {
  const relay = createRelay(), clients = [];
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${relay.server.address().port}`;
  const client = code => { const c = new scope.Client(address, code); clients.push(c); return c; };
  try {
    assert.equal((await fetch(address)).status, 200);
    assert.equal((await fetch(address + '/socket.io/socket.io.js')).status, 200);
    const code = 'nw-1234567890abcdef', host = client(code);
    assert.equal(await once(host, 'open'), code);
    const guest = client(); await once(guest, 'open');
    assert.notEqual(guest.id, host.id);
    const incoming = once(host, 'connection');
    const guestChannel = guest.connect(code);
    await once(guestChannel, 'open');
    const hostChannel = await incoming;
    assert.equal(hostChannel.open, true);
    const join = once(hostChannel, 'data');
    guestChannel.send({ type: 'join', protocol: 1 });
    assert.equal((await join).type, 'join');
    const map = once(guestChannel, 'data');
    const actor = (id, x) => ({ id, x, y: 200, hp: 80, maxHp: 80, r: 13, spawnVersion: 1, weapon: 'pistol' });
    const level = { mapType: 'desert', cols: 3, rows: 2, roomW: 440, roomH: 340, worldW: 1320, worldH: 680,
      walls: [], pillars: [], crates: [], enemies: [], openings: [], rooms: [{ x: 0, y: 0, col: 0, row: 0 }] };
    const initial = { round: 1, started: true, time: 0,
      rules: { combat: 'pvp', mapType: 'desert', playerMaxHp: 80, mode: 'infinite', playerDamageMultiplier: 1 },
      player: actor(code, 200), players: [actor(guest.id, 300)] };
    host.socket.emit('relay', { message: { type: 'map', map: level, snapshot: initial } });
    hostChannel.send({ type: 'map', map: level, snapshot: initial, localId: guest.id });
    assert.equal((await map).localId, guest.id);
    const input = once(hostChannel, 'data');
    guestChannel.send({ type: 'playerState', round: 1, input: { seq: 1, x: 300, y: 200, angle: 0, weapon: 'pistol', spawnVersion: 1, keys: ['KeyW'] } });
    assert.equal((await input).input.keys[0], 'KeyW');
    const snapshot = once(guestChannel, 'data');
    host.socket.emit('relay', { message: { type: 'playerState', seq: 1, snapshot: { ...initial, enemies: [{ x: 30 }], time: 5 } } });
    assert.equal((await snapshot).snapshot.time, 5);
    const guest2 = client(); await once(guest2, 'open');
    const channel2 = guest2.connect(code); await once(channel2, 'open');
    const guest2Map = once(channel2, 'data', m => m.type === 'map');
    host.channels.get(guest2.id).send({ type: 'map', map: level, snapshot: { ...initial,
      players: [...initial.players, actor(guest2.id, 500)] }, localId: guest2.id });
    await guest2Map;
    const hostFire = once(host, 'game-message', p => p.message.type === 'fireEvent');
    const otherFire = once(guest2, 'game-message', p => p.message.type === 'fireEvent');
    guest.socket.emit('relay', { message: { type: 'fireEvent', id: 'shot1', actorId: guest.id,
      weapon: 'katana', x: 300, y: 200, angle: 0, timestamp: Date.now(), round: 1, spawnVersion: 1, bullets: [{ x: 999 }] } });
    const fire = await hostFire;
    assert.equal(fire.message.actorId, guest.id);
    assert.equal((await otherFire).message.id, 'shot1');
    assert.equal('bullets' in fire.message, false);
    const heartbeat = once(host, 'game-message', p => p.message.type === 'heartbeat');
    const echo = once(guest, 'game-message', p => p.message.type === 'heartbeat');
    guest.socket.emit('relay', { message: { type: 'heartbeat', timestamp: 456 } });
    assert.equal((await heartbeat).from, guest.id);
    assert.equal((await echo).message.timestamp, 456);
    const missing = client(); await once(missing, 'open');
    const error = once(missing, 'error'); missing.connect('missing');
    assert.equal((await error).type, 'room-not-found');
    const duplicate = client(code);
    assert.equal((await once(duplicate, 'error')).type, 'room-unavailable');
    const outsider = client(); await once(outsider, 'open');
    let forged = false;
    hostChannel.on('data', data => { if (data.forged) forged = true; });
    outsider.socket.emit('relay', { target: code, message: { type: 'input', forged: true } });
    const disconnected = once(guestChannel, 'close');
    host.destroy(); await disconnected;
    assert.equal(relay.rooms.size, 0); assert.equal(forged, false);
    const retry = client(code); assert.equal(await once(retry, 'open'), code);
    console.log('PASS: syntax; static page/client script; rooms; playerState; three-client fireEvent broadcast; sender binding; heartbeat echo; missing/duplicate rooms; isolation; host disconnect; recreate.');
  } finally {
    for (const c of clients) c.destroy();
    await new Promise(resolve => relay.io.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
