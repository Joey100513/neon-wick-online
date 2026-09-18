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
game.state.muted = true;
assert.equal(game.rooms.length, 72);
assert.equal(game.enemies.length, 72);
const enemy = game.enemies[0], hp = enemy.hp;
game.damage(enemy, 1);
assert.equal(enemy.hp, hp - 1, 'Single-player damage remains local');
game.network.mode = 'host'; game.network.localId = 'host';
game.roomRules = { ...game.roomRules, mapType: 'desert', combat: 'pvp', playerMaxHp: 80, laser: false, nailgun: true, gatling: false };
game.restart();
assert.equal(game.WORLD_W * game.WORLD_H, 6 * 440 * 340);
assert.equal(game.rooms.length, 6); assert.equal(game.enemies.length, 0);
assert.ok(game.pillars.every(p => p.cactus));
assert.ok(game.crates.every(c => c.tumbleweed));
assert.equal(game.spawnMonster(), false);
assert.equal(game.weaponAllowed('laser'), false); assert.equal(game.weaponAllowed('katana'), true);
assert.equal(game.weaponAllowed('nailgun'), true);
game.walls.length = 0; game.pillars.length = 0; game.crates.length = 0;
game.network.mode = 'guest'; game.network.ready = true; game.network.gameStarted = true;
game.network.localId = 'self'; game.player.id = 'self';
game.network.roomId = 'host';
const sent = [];
game.network.peer = { socket: { connected: true, emit: (name, packet) => sent.push(packet.message) } };
game.resetPrediction();
for (now = 0; now <= 1000; now++) game.sendGuestInput();
assert.equal(sent.length, 17);
assert.ok(sent.every(m => m.type === 'playerState' && Number.isFinite(m.input.x) && !('firing' in m.input)));
game.state.menu = false; game.state.paused = false;
game.player.hp = 80; game.player.weapon = 'pistol'; game.player.dashActive = false;
game.player.x = 200; game.player.y = 200; game.keys.add('KeyD');
game.update(1 / 60);
assert.ok(game.player.x > 200, 'Prediction moves immediately without acknowledgement');
assert.ok(game.network.motionX > 0);
game.keys.clear();
const own = { id: 'self', x: 200, y: 200, hp: 80, spawnVersion: game.player.spawnVersion, rev: 0, ack: 0 };
game.applyServerPlayer(own, true);
game.applyServerPlayer({ ...own, id: 'host', x: 300 }, true);
game.applyServerPlayer({ ...own, id: 'host', x: 400 });
game.update(1 / 60);
assert.ok(game.remotePlayers.get('host').x > 300 && game.remotePlayers.get('host').x < 400);
game.resetPrediction(); game.player.x = 220;
game.network.motionX = 20;
game.network.pending.set(1, { x: 210, y: 200, motionX: 10, motionY: 0 });
game.network.pending.set(2, { x: 220, y: 200, motionX: 20, motionY: 0 });
game.applyServerPlayer({ ...own, ack: 1, x: 200 });
assert.equal(game.player.x + game.network.correctionX, 210);
game.update(1 / 60);
game.applyServerPlayer({ ...own, ack: 2, x: 210 });
assert.equal(game.player.x + game.network.correctionX, 210, 'Multiple pending samples do not compound correction');
game.applyServerPlayer(own, true);

// Repeated corrections must not feed earlier corrections back into predicted movement.
game.resetPrediction();
let seq = 0;
for (let i = 0; i < 12000; i++) {
  now += 60;
  const dx = i % 120 < 60 ? 0.3 : -0.3;
  game.network.motionX += dx; game.player.x += dx;
  game.network.pending.set(++seq, { x: game.player.x, y: game.player.y,
    motionX: game.network.motionX, motionY: game.network.motionY });
  const authority = { ...own, ack: seq, x: game.player.x - dx * 0.1 };
  game.handleGameMessage({ from: 'server', message: { type: 'playerState', round: game.network.round, seq, players: [authority] } });
  game.handleGameMessage({ from: 'server', message: { type: 'playerState', round: game.network.round, seq: seq - 1, players: [{ ...authority, x: -999999 }] } });
  game.update(1 / 60);
  assert.ok(Number.isFinite(game.camera.x) && game.player.x > 150 && game.player.x < 250);
}
const px = game.player.x;
for (const bad of [NaN, Infinity, null, -1e9]) game.applyServerPlayer({ ...own, x: bad });
assert.equal(game.player.x, px, 'Invalid coordinates cannot poison the player or camera');
game.applyServerPlayer({ ...own, x: 500, spawnVersion: own.spawnVersion + 1, rev: 10 });
game.applyServerPlayer({ ...own, x: 0, spawnVersion: own.spawnVersion, rev: 9 });
assert.equal(game.player.x, 500, 'Old life snapshots cannot teleport a respawned player');
assert.equal(game.player.spawnVersion, own.spawnVersion + 1);
game.player.x = NaN; game.followLocalPlayer();
assert.equal(game.player.x, 500, 'Corrupted local coordinates recover from the last valid authority');
game.player.angle = 0; game.resetPrediction();
game.network.pending.set(20001, { x: 500, y: 200, motionX: 0, motionY: 0 });
assert.equal(game.startDash(), true);
game.stopDash();
const dashedX = game.player.x;
assert.ok(dashedX > 500 && game.network.motionX > 0);
game.applyServerPlayer({ ...own, x: 500, ack: 20001, spawnVersion: game.player.spawnVersion, rev: 10 });
assert.equal(game.player.x, dashedX, 'Tap dash outside the frame loop survives pre-dash acknowledgements');
assert.ok(game.hardBlocked(Infinity, 200, 12));
assert.ok(game.hardBlocked(NaN, 200, 12));
assert.ok(game.hardBlocked(game.WORLD_W + 10000, 200, 12), 'Destroyed perimeter cannot let movement escape the world');
game.applyServerPlayer({ ...own, x: 500, spawnVersion: game.player.spawnVersion, rev: 10 }, true);

game.player.draw = 0; game.player.reload = null; game.player.cooldown = 0;
game.player.ammo.pistol.mag = 10;
assert.equal(game.shoot(game.player, 'pistol', 0), true);
const shot = game.bullets.at(-1);
assert.ok(shot.fireId && shot.alive && game.camera.shake > 0 && game.player.muzzle > 0);
assert.equal(sent.at(-1).type, 'fireEvent');
const world = game.gameSnapshot();
world.players = [{ ...own, x: -900, hp: 0 }];
game.applyGameSnapshot(world);
const clock = game.state.time;
game.applyGameSnapshot({ time: Infinity }); assert.equal(game.state.time, clock);
game.applyGameSnapshot({ time: 0 }); assert.equal(game.state.time, clock);
assert.equal(game.player.x, 500, 'Host world snapshots cannot override server positions');
assert.equal(game.player.hp, 80, 'Host world snapshots cannot override authoritative health');
assert.ok(game.bullets.includes(shot), 'World snapshots cannot erase bullets');
const bx = shot.x; game.update(1 / 60);
assert.ok(shot.x > bx);
assert.equal('bullets' in game.gameSnapshot(), false);
const beforeHp = game.player.hp;
game.predictHit(game.player, { fireId: 'enemy-1:shot', actorId: 'enemy-1' });
assert.equal(game.player.hp, beforeHp);
assert.ok(game.network.hurtFlash > 0);
assert.equal(sent.at(-1).type, 'hitClaim');
const beforeDuplicate = sent.length;
game.predictHit(game.player, { fireId: 'enemy-1:shot', actorId: 'enemy-1' });
assert.equal(sent.length, beforeDuplicate);
game.damage(game.player, 1000);
assert.equal(game.player.hp, beforeHp, 'No local damage or death in multiplayer');
game.handleGameMessage({ from: 'server', message: { type: 'killConfirm', round: game.network.round, seq: 1,
  targetId: 'self', fireId: 'enemy-1:shot', target: { ...own, x: 500, hp: 70, spawnVersion: game.player.spawnVersion, rev: 11 } } });
assert.equal(game.player.hp, 70);
game.handleGameMessage({ from: 'forged', message: { type: 'killConfirm', round: game.network.round, seq: 2,
  targetId: 'self', target: { ...own, hp: 0 } } });
assert.equal(game.player.hp, 70);

game.network.lastNpcSeq = -1;
game.applyNpcUpdate({ round: game.network.round, seq: 1, enemies: [{ id: 'enemy-0', x: 700, y: 400, hp: 30, r: 12, weapon: 'pistol' }] });
game.applyNpcUpdate({ round: game.network.round, seq: 2, enemies: [{ id: 'enemy-0', x: 800, y: 400, hp: 30, r: 12, weapon: 'pistol' }] });
game.update(1 / 60);
assert.ok(game.enemies[0].x > 700 && game.enemies[0].x < 800);
const remoteShot = { type: 'fireEvent', id: 'remote-shot', actorId: 'host', x: 400, y: 200,
  angle: 0, weapon: 'pistol', timestamp: now, round: game.network.round };
const count = game.bullets.length;
game.receiveFire(remoteShot, 'host'); game.receiveFire(remoteShot, 'host');
assert.equal(game.bullets.length, count + 1);
game.receiveFire({ ...remoteShot, id: 'remote-slash', weapon: 'katana' }, 'host');
assert.ok(game.remotePlayers.get('host').swing);
const queuedCount = game.bullets.length;
game.receiveFire({ ...remoteShot, id: 'early-shot', actorId: 'new-player' }, 'new-player');
assert.equal(game.bullets.length, queuedCount);
game.handleGameMessage({ from: 'server', message: { type: 'playerState', round: game.network.round, seq: 30000,
  players: [{ ...own, id: 'new-player', x: 900, y: 400 }] } });
assert.equal(game.bullets.length, queuedCount + 1, 'Fire arriving before the actor is buffered');
game.draw();

const wall = { x: 20, y: 0, w: 10, h: 40, hp: 100, maxHp: 100, kind: 'wall' };
game.walls.push(wall);
for (const weapon of ['pistol', 'gatling', 'rocket']) {
  game.advanceBullet({ x: 0, y: 20, dx: 1, dy: 0, speed: 100, damage: 20,
    shooter: game.player, weapon, remaining: 100, bounces: 0, alive: true }, 40);
  assert.equal(wall.hp, 100);
}
const seenAt = game.remotePlayers.get('host').lastSeen;
game.network.lastHostSeen = 1e9;
now = seenAt + 4000; game.networkMaintenance();
assert.ok(game.remotePlayers.has('host'));
now++; game.networkMaintenance();
assert.equal(game.remotePlayers.has('host'), false);
sent.length = 0; now = 1e7; game.network.lastHeartbeatAt = -Infinity;
game.networkMaintenance(); now += 1499; game.networkMaintenance();
assert.equal(sent.length, 1); now++; game.networkMaintenance();
assert.equal(sent.length, 2); assert.equal(sent[0].type, 'heartbeat');
game.network.mode = 'single'; game.state.mapType = 'rooms'; game.state.enemyCount = 72;
game.restart(); assert.equal(game.rooms.length, 72); assert.equal(game.player.weapon, 'laser');
console.log('PASS: single-player; desert/loadouts; 60ms throttle; prediction/lerp; 12000 corrections; invalid/stale/life packets; local shots; visual hits without damage; server-only HP; NPC interpolation; katana; 4s liveness; 1.5s heartbeat.');
