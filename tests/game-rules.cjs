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
  setTimeout: () => 1, clearTimeout: noop, requestAnimationFrame: noop, URL,
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
assert.equal(game.weaponAllowed('laser'), false); assert.equal(game.weaponAllowed('katana'), false);
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
game.network.mode = 'single'; game.state.mapType = 'rooms'; game.state.enemyCount = 72;
game.restart(); assert.equal(game.rooms.length, 72); assert.equal(game.player.weapon, 'laser');
console.log('PASS: single-player; desert size/cover/loadout; PVP damage/challenge respawn; per-player recurring drops; recurring chips; stale respawn packets; 60ms throttle; prediction; remote lerp; own-player snapshot identity.');
