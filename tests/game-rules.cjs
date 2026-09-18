const vm = require('node:vm');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('node:path').join(__dirname, '../neon-wick-room36.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
new vm.Script(source);
const noop = () => {};
const drawing = new Proxy({}, { get: (o, k) => o[k] || noop, set: (o, k, v) => (o[k] = v, true) });
const elements = new Map();
function element(id) {
  if (!elements.has(id)) elements.set(id, {
    id, hidden: false, value: '', width: 1100, height: 690, textContent: '', style: {}, dataset: {},
    classList: { add: noop, remove: noop, toggle: noop }, setAttribute: noop, addEventListener: noop, append: noop,
    getContext: () => drawing, focus: noop, blur: noop, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1100, height: 690 }),
  });
  return elements.get(id);
}
let now = 0, game;
const scope = vm.createContext({
  console, structuredClone, performance: { now: () => now },
  setTimeout: () => 1, clearTimeout: noop, setInterval: () => 1, clearInterval: noop, requestAnimationFrame: noop, URL,
  location: { protocol: 'https:', hostname: 'example.com', origin: 'https://example.com' },
  document: { getElementById: element, querySelector: element, querySelectorAll: () => [], createElement: () => element(Symbol()), addEventListener: noop },
  window: { addEventListener: noop }, globalThis: { __collectGame: g => { game = g; } },
});
vm.runInContext(source, scope);
assert.equal(game.rooms.length, 72);
assert.equal(game.enemies.length, 72);
game.network.mode = 'host'; game.network.localId = 'host';
game.roomRules = { ...game.roomRules, mapType: 'desert', combat: 'pvp', playerMaxHp: 80, laser: false, nailgun: true, gatling: false };
game.restart();
assert.equal(game.ROOM_W, 440); assert.equal(game.ROOM_H, 340);
assert.equal(game.WORLD_W * game.WORLD_H, 6 * 440 * 340);
assert.equal(game.rooms.length, 6); assert.equal(game.enemies.length, 0);
assert.ok(game.pillars.every(p => p.cactus));
assert.ok(game.crates.every(c => c.tumbleweed));
assert.equal(game.spawnMonster(), false);
assert.equal(game.player.weapon, 'pistol');
assert.equal(game.weaponAllowed('laser'), false); assert.equal(game.weaponAllowed('katana'), true);
assert.equal(game.weaponAllowed('nailgun'), true);
const remote = game.makeRemotePlayer('guest', { x: game.player.x, y: game.player.y });
game.remotePlayers.set(remote.id, remote);
assert.equal(remote.hasNailgun, true); assert.equal(remote.hp, 80);
remote.grace = 0;
game.damage(remote, 81, false, game.player);
assert.equal(game.player.pvpKills, 1); assert.equal(remote.deaths, 1); assert.equal(remote.hp, 80);
game.roomRules = { ...game.roomRules, combat: 'pvevp', mapType: 'rooms', enemyCount: 30 };
game.restart();
assert.equal(game.enemies.length, 30);
game.player.grace = 0;
for (const enemy of game.enemies.slice(0, 20)) game.damage(enemy, 10000, false, game.player);
assert.equal(game.player.enemyKills, 20); assert.equal(game.player.pendingDrops, 2);
game.updateAirdrop(0.1); game.updateAirdrop(0.1);
assert.equal(game.airdrops.filter(d => d.kind === 'red').length, 2);
assert.ok(game.airdrops.filter(d => d.kind === 'red').every(d => d.ownerId === 'host'));
for (let tier = 0; tier < 4; tier++) {
  game.state.monsterTier = tier;
  assert.equal(game.spawnMonster(), true);
  game.damage(game.monster, Infinity, false, game.player);
}
assert.equal(game.chipDrops.length, 4);
assert.deepEqual(Array.from(game.chipDrops, c => c.ability), ['sandevistan', 'stealth', 'sandevistan', 'stealth']);
const challenged = game.makeRemotePlayer('challenged', { x: game.player.x, y: game.player.y });
game.remotePlayers.set(challenged.id, challenged);
game.state.mode = 'challenge'; game.state.challengeRespawns = 1;
for (let n = 0; n < 2; n++) { challenged.grace = 0; game.damage(challenged, 1000, false, game.player); }
assert.equal(challenged.hp, 0); assert.equal(challenged.deaths, 2);
game.state.mode = 'infinite';
const oldVersion = remote.spawnVersion;
game.respawnMultiplayer(remote);
remote.input = { seq: 99, x: -100000, y: -100000, spawnVersion: oldVersion };
const spawnX = remote.x;
game.acceptPosition(remote); assert.equal(remote.x, spawnX);
game.network.mode = 'guest'; game.network.ready = true;
const sent = [];
game.network.connection = { open: true, send: m => sent.push(m) };
for (now = 0; now <= 1000; now += 1) game.sendGuestInput();
assert.equal(sent.length, 17);
assert.ok(sent.every(m => Number.isFinite(m.input.x) && Number.isFinite(m.input.y)));
game.state.menu = false; game.state.paused = false;
game.player.hp = 80; game.player.weapon = 'pistol'; game.player.dashActive = false;
game.keys.add('KeyD');
const cell = game.nav.cells.find(c => !game.blocked(c.x + 10, c.y, 15));
game.player.x = cell.x; game.player.y = cell.y;
game.update(1 / 60);
assert.ok(game.player.x > cell.x, 'Local prediction moves before a snapshot');
game.keys.clear();
game.remotePlayers.set('other', { ...remote, x: 0, y: 0, targetX: 100, targetY: 100 });
game.update(1 / 60);
assert.ok(game.remotePlayers.get('other').x > 0 && game.remotePlayers.get('other').x < 100);
const snapshot = game.gameSnapshot();
snapshot.players = [{ ...snapshot.player, id: 'guest-self', spawnVersion: 7, x: 200, y: 250 }];
snapshot.player = { ...snapshot.player, id: 'host-player', x: 300, y: 350 };
game.network.localId = 'guest-self';
game.applyGameSnapshot(snapshot);
assert.equal(game.player.x, 200); assert.equal(game.player.y, 250);
snapshot.player.x = 400;
game.applyGameSnapshot(snapshot);
assert.equal(game.remotePlayers.get('host-player').x, 300);
assert.equal(game.remotePlayers.get('host-player').targetX, 400);
game.state.muted = true;
game.player.draw = 0; game.player.reload = null; game.player.cooldown = 0;
game.player.ammo.pistol.mag = 10;
const packets = [];
game.network.peer = { socket: { connected: true, emit: (name, packet) => packets.push(packet.message) } };
game.network.fireSeq = 0;
assert.equal(game.shoot(game.player, 'pistol', 0), true);
const shot = game.bullets.at(-1);
assert.ok(shot.alive); assert.ok(game.camera.shake > 0); assert.ok(game.player.muzzle > 0);
assert.equal(packets.at(-1).type, 'fireEvent');
assert.equal(packets.at(-1).weapon, 'pistol');
assert.equal(game.player.ammo.pistol.mag, 9);
game.applyGameSnapshot(snapshot);
assert.ok(game.bullets.includes(shot), 'Position snapshots must not erase projectiles');
assert.equal(game.player.ammo.pistol.mag, 9, 'Stale snapshots must not undo predicted ammo');
assert.ok(game.player.muzzle > 0);
assert.equal('bullets' in game.gameSnapshot(), false);
game.walls.length = 0; game.pillars.length = 0; game.crates.length = 0; game.enemies.length = 0;
const bx = shot.x;
game.update(1 / 60);
assert.ok(shot.x > bx, 'Guest simulates local projectile movement');
game.network.gameStarted = true;
const event = { type: 'fireEvent', actorId: 'host-player', id: 'test-shot', weapon: 'pistol',
  x: 400, y: 350, angle: 0, timestamp: 10, round: game.network.round };
const count = game.bullets.length;
game.receiveFire(event, 'host-player'); game.receiveFire(event, 'host-player');
assert.equal(game.bullets.length, count + 1, 'Duplicate events produce one shot');
game.receiveFire({ ...event, id: 'slash', weapon: 'katana' }, 'host-player');
assert.ok(game.remotePlayers.get('host-player').swing);
game.draw();
snapshot.player = null; snapshot.players = [];
game.applyGameSnapshot(snapshot);
assert.ok(game.remotePlayers.has('host-player'), 'Missing snapshot entries are retained');
const seenAt = game.remotePlayers.get('host-player').lastSeen;
game.network.lastHostSeen = 1e9;
now = seenAt + 4000; game.networkMaintenance();
assert.ok(game.remotePlayers.has('host-player'));
now++; game.networkMaintenance();
assert.equal(game.remotePlayers.has('host-player'), false);
packets.length = 0; now = 10000; game.network.lastHeartbeatAt = -Infinity;
game.networkMaintenance(); now += 1499; game.networkMaintenance();
assert.equal(packets.length, 1); now++; game.networkMaintenance();
assert.equal(packets.length, 2); assert.equal(packets[0].type, 'heartbeat');
const wall = { x: 20, y: 0, w: 10, h: 40, hp: 100, maxHp: 100, kind: 'wall' };
game.walls.push(wall);
for (const weapon of ['pistol', 'gatling', 'rocket']) {
  game.advanceBullet({ x: 0, y: 20, dx: 1, dy: 0, speed: 100, damage: 20,
    shooter: game.player, weapon, remaining: 100, bounces: 0, alive: true }, 40);
  assert.equal(wall.hp, 100, 'Guest projectile effects cannot modify authoritative walls');
}
game.network.mode = 'host'; game.network.localId = 'host';
const firingGuest = game.makeRemotePlayer('firing-guest', { x: 700, y: 500 });
game.remotePlayers.set(firingGuest.id, firingGuest);
firingGuest.input = { firing: true, justPressed: true, weapon: 'pistol' };
const mag = firingGuest.ammo.pistol.mag, beforeHostShot = game.bullets.length;
game.receiveFire({ ...event, id: 'host-accept', actorId: firingGuest.id, x: 700, y: 500,
  spawnVersion: firingGuest.spawnVersion }, firingGuest.id);
assert.equal(firingGuest.ammo.pistol.mag, mag - 1);
assert.equal(game.bullets.length, beforeHostShot + 1);
game.updateRemotePlayer(firingGuest, 0.01);
assert.equal(game.bullets.length, beforeHostShot + 1, 'Position input cannot also fire');
game.network.mode = 'single'; game.state.mapType = 'rooms'; game.state.enemyCount = 72;
game.restart(); assert.equal(game.rooms.length, 72); assert.equal(game.player.weapon, 'laser');
console.log('PASS: single-player; desert/loadouts; PVP/PVEVP; 60ms throttle; prediction; lerp; immediate local fire; snapshot persistence/ammo; guest projectile simulation; fire deduplication; katana rendering; >4s retention; 1.5s heartbeat.');
