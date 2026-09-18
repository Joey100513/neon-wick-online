'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { io: clientIo } = require('socket.io-client');
const { createRelay, RoundAuthority, GUNS, CONSTANTS, RATE_LIMITS, takeRate,
  rayRect, rayCircle, traceShot, sampleHistory, sanitizeWorldSnapshot } = require('../server.js');

const CODE = 'nw-1234567890abcdef';
function level(overrides = {}) {
  return { mapType: 'rooms', cols: 4, rows: 3, roomW: 220, roomH: 170,
    worldW: 880, worldH: 510, rooms: [{ x: 0, y: 0, col: 0, row: 0 }],
    walls: [], pillars: [], crates: [], enemies: [], openings: [], ...overrides };
}
function seed(id, x = 100, y = 200, overrides = {}) {
  return { id, x, y, angle: 0, r: 13, hp: 30, maxHp: 30, spawnVersion: 1, grace: 0,
    weapon: 'pistol', ...overrides };
}
function fakeSocket(id, host = false) {
  return { id, connected: true, data: { host, room: CODE, lastSeen: 10000 }, sent: [],
    emit(event, packet) { this.sent.push({ event, ...packet }); } };
}
function fixture(options = {}) {
  let time = 10000, fireSeq = 0;
  const host = fakeSocket('host-socket', true);
  const guest = fakeSocket('guest');
  const room = { code: CODE, host, guests: new Map([[guest.id, guest]]) };
  const map = level(options.map);
  const snapshot = { round: 1, started: true, rules: { combat: 'pvevp', ...options.rules },
    player: seed(CODE, 100, 200, options.hostSeed),
    players: [seed(guest.id, 300, 200, options.guestSeed)],
    enemies: options.enemies || [], ...options.snapshot };
  const authority = new RoundAuthority(room, map, snapshot, {
    now: () => time, random: () => 0.5, npcs: options.npcs === true,
  });
  const f = {
    authority, host, guest, room, map, snapshot, now: () => time,
    advance(ms, tick = true) { time += ms; if (tick) authority.tick(); },
    player: authority.players.get(CODE), target: authority.players.get('guest'),
    input(socket, overrides = {}) {
      const actor = authority.players.get(socket.data.host ? CODE : socket.id);
      return authority.acceptInput(socket, { type: 'playerState', round: authority.round, input: {
        seq: actor.ack + 1, x: actor.x, y: actor.y, angle: 0, spawnVersion: actor.spawnVersion,
        weapon: actor.weapon, ...overrides,
      } });
    },
    fire(socket = host, overrides = {}) {
      const actor = authority.players.get(socket.data.host ? CODE : socket.id);
      const message = { type: 'fireEvent', id: `shot-${++fireSeq}`, actorId: actor.id, round: authority.round,
        spawnVersion: actor.spawnVersion, weapon: 'pistol', x: actor.x, y: actor.y, angle: 0,
        timestamp: time, ...overrides };
      return { accepted: authority.acceptFire(socket, message), message };
    },
    claim(shot, socket = host, targetId = 'guest', pellet = 0, overrides = {}) {
      return authority.acceptClaim(socket, { type: 'hitClaim', round: authority.round,
        fireId: typeof shot === 'string' ? shot : shot.message.id, targetId, pellet, ...overrides });
    },
  };
  return f;
}

test('CommonJS compatibility wrapper exports the standalone server', () => {
  assert.equal(require('../server.cjs').createRelay, createRelay);
  assert.equal(Object.isFrozen(GUNS), true);
  assert.equal(Object.isFrozen(GUNS.rifle), true);
});

test('project collision primitives preserve contact normals and inside-circle hits', () => {
  assert.deepEqual(rayRect(0, 20, 1, 0, 100, { x: 20, y: 0, w: 10, h: 40 }),
    { distance: 20, nx: -1, ny: 0 });
  assert.equal(rayRect(0, 50, 1, 0, 100, { x: 20, y: 0, w: 10, h: 40 }), null);
  assert.deepEqual(rayCircle(20, 20, 1, 0, 100, { x: 20, y: 20, r: 13 }), { distance: 0 });
  assert.equal(rayCircle(0, 0, 1, 0, 100, { x: 20, y: 50, r: 13 }), null);
});

test('initial actors use bounded server HP, radius, and score; IDs are never reassigned', () => {
  const f = fixture({ hostSeed: { hp: 999999, r: 900, deaths: 99, pvpKills: 100 },
    guestSeed: { maxHp: 1e30, enemyKills: 999 } });
  assert.equal(f.player.hp, 30);
  assert.equal(f.player.r, 13);
  assert.equal(f.player.pvpKills, 0);
  assert.equal(f.target.maxHp, 30);
  assert.equal(f.target.enemyKills, 0);
  assert.equal(f.authority.players.size, 2);
  assert.equal(f.player.id, CODE);
});

test('host and guest ownership, numeric bounds, cooldown, round and life gate firing', () => {
  const f = fixture();
  for (const overrides of [
    { actorId: 'guest' }, { actorId: 'enemy-0' }, { round: 0 }, { spawnVersion: 99 },
    { x: 700 }, { y: NaN }, { angle: Infinity }, { timestamp: NaN },
    { weapon: 'constructor' }, { weapon: 'laser' }, { weapon: 'nailgun' },
    { weapon: 'gatling' }, { id: '' }, { id: 'server:spoof' },
  ]) assert.equal(f.fire(f.host, overrides).accepted, false, JSON.stringify(overrides));
  assert.equal(f.fire(f.guest, { actorId: CODE }).accepted, false);
  assert.equal(f.authority.shots.size, 0);
  const first = f.fire();
  assert.equal(first.accepted, true);
  assert.equal(f.fire().accepted, false);
  f.advance(219);
  assert.equal(f.fire().accepted, false);
  f.advance(1);
  assert.equal(f.fire().accepted, true);
  f.advance(220);
  assert.equal(f.fire(f.host, { id: first.message.id }).accepted, false);
  assert.equal(f.fire(f.host, { x: f.player.x + 40 }).accepted, true, '60ms predicted origin is accepted');
  f.advance(220);
  f.player.hp = 0;
  assert.equal(f.fire().accepted, false);
});

test('HP changes only from an owned recorded shot; each accepted hit confirms and increments revision', () => {
  const f = fixture();
  assert.equal(f.claim('missing'), false);
  const shot = f.fire();
  assert.equal(shot.accepted, true);
  const stored = f.authority.shots.get(shot.message.id);
  assert.ok(Object.isFrozen(stored) && Object.isFrozen(stored.impacts) && Object.isFrozen(stored.impacts[0]));
  assert.equal(f.claim(shot, f.guest), false);
  assert.equal(f.claim(shot, f.host, 'guest', 1), false);
  assert.equal(f.claim(shot, f.host, 'guest', 0, { round: 99 }), false);
  const rev = f.target.rev;
  assert.equal(f.claim(shot), true);
  assert.equal(f.target.hp, 29);
  assert.equal(f.target.rev, rev + 1);
  assert.equal(f.claim(shot), false);
  const confirmation = f.guest.sent.find(p => p.message?.type === 'killConfirm');
  assert.equal(confirmation.from, 'server');
  assert.equal(confirmation.message.damage, GUNS.pistol.damage);
  assert.equal(confirmation.message.killed, false);
  assert.equal(confirmation.message.target.rev, f.target.rev);
  assert.equal(confirmation.message.shooter.rev, f.player.rev);
  assert.equal(confirmation.message.fireId, shot.message.id);
});

test('death respawns at a bounded unobstructed position, increments life and scores, invalidates old shots', () => {
  const f = fixture({ rules: { playerMaxHp: 1 } });
  const shot = f.fire();
  const oldLife = f.target.spawnVersion;
  assert.equal(f.claim(shot), true);
  assert.equal(f.target.hp, 1);
  assert.equal(f.target.deaths, 1);
  assert.equal(f.player.pvpKills, 1);
  assert.equal(f.target.spawnVersion, oldLife + 1);
  assert.ok(f.target.rev >= 4);
  assert.equal(f.authority.blocked(f.target.x, f.target.y, f.target.r), false);
  assert.equal(f.authority.inBounds(f.target.x, f.target.y, f.target.r), true);
  assert.equal(f.claim(shot), false);
  assert.equal(f.input(f.guest, { spawnVersion: oldLife }), null);
  const event = f.host.sent.find(p => p.message?.type === 'killConfirm').message;
  assert.equal(event.killed, true);
  assert.equal(event.target.hp, 1, 'confirmation carries the new authoritative life');
  assert.equal(event.target.grace, 1.6);
});

test('challenge deaths exhaust respawns; heartbeat never resurrects a dead or expired life', () => {
  const f = fixture({ rules: { mode: 'challenge', challengeRespawns: 0, playerMaxHp: 1 } });
  assert.equal(f.claim(f.fire()), true);
  const life = f.target.spawnVersion, rev = f.target.rev;
  assert.equal(f.target.hp, 0);
  f.advance(4001);
  assert.equal(f.target.active, false);
  f.authority.touch(f.guest, f.now());
  assert.equal(f.target.active, true);
  assert.equal(f.target.hp, 0);
  assert.equal(f.target.spawnVersion, life);
  assert.equal(f.target.rev, rev);
  assert.equal(f.fire(f.guest).accepted, false);
});

test('wall, pillar, crate, and origin obstruction block claims; the first actor consumes the ray', () => {
  const rect = { x: 190, y: 0, w: 20, h: 400, hp: 35 };
  for (const kind of ['walls', 'pillars', 'crates']) {
    const f = fixture({ map: { [kind]: [rect] } });
    const shot = f.fire();
    assert.equal(shot.accepted, true);
    assert.equal(f.claim(shot), false, kind);
    f.authority.map[kind] = [];
    assert.equal(f.claim(shot), false, 'later destruction cannot rewrite a shot');
  }
  const f = fixture({ map: { walls: [{ x: 125, y: 150, w: 8, h: 100, hp: 35 }] } });
  assert.equal(f.fire(f.host, { x: 145 }).accepted, false, 'moved origin cannot cross a wall');
  const g = fixture({ enemies: [seed('enemy-0', 200, 200)] });
  const shot = g.fire();
  assert.equal(g.claim(shot), false);
  assert.equal(g.claim(shot, g.host, 'enemy-0'), true);
  assert.equal(g.claim(shot), false);
});

test('rewind interpolates only within the same life and keeps exactly discrete HP/liveness', () => {
  const history = [
    { at: 0, x: 0, y: 0, angle: 3.1, hp: 30, spawnVersion: 1, active: true, graceUntil: 0 },
    { at: 100, x: 100, y: 100, angle: -3.1, hp: 29, spawnVersion: 1, active: true, graceUntil: 0 },
    { at: 200, x: 900, y: 900, angle: 0, hp: 30, spawnVersion: 2, active: true, graceUntil: 300 },
  ];
  assert.equal(sampleHistory(history, -1), null);
  const middle = sampleHistory(history, 50);
  assert.equal(middle.x, 50);
  assert.equal(middle.hp, 30);
  assert.ok(Math.abs(Math.abs(middle.angle) - Math.PI) < 0.01);
  assert.equal(sampleHistory(history, 150).x, 100, 'no interpolation across spawn versions');
  assert.equal(sampleHistory(history, 200).spawnVersion, 2);
});

test('lag compensation uses receipt time minus measured RTT, never client timestamp, ping or claim time', () => {
  const f = fixture({ guestSeed: { y: 180 } });
  f.host.data.rtt = 100;
  f.advance(100, false);
  f.target.y = 220;
  f.authority.record(f.target, f.now());
  const shot = f.fire(f.host, { timestamp: -1e12, ping: 999999 });
  assert.equal(shot.accepted, true);
  const saved = f.authority.shots.get(shot.message.id);
  assert.equal(saved.receivedAt, 10100);
  assert.equal(saved.rewindAt, 10050);
  assert.equal(saved.impacts[0].targetId, 'guest');
  f.advance(500, false);
  f.target.y = 400;
  f.authority.record(f.target, f.now());
  assert.equal(f.claim(shot, f.host, 'guest', 0, { timestamp: 0, ping: 0 }), true);
  const noRtt = fixture({ guestSeed: { y: 180 } });
  noRtt.advance(100, false);
  noRtt.target.y = 220;
  noRtt.authority.record(noRtt.target, noRtt.now());
  assert.equal(noRtt.claim(noRtt.fire(noRtt.host, { timestamp: 10050, ping: 100 })), false);
});

test('stale shooter/target lives, spawn grace, and expired records cannot accept hits', () => {
  const f = fixture();
  const shot = f.fire();
  f.target.spawnVersion++;
  assert.equal(f.claim(shot), false);
  f.target.spawnVersion--;
  f.player.spawnVersion++;
  assert.equal(f.claim(shot), false);
  const grace = fixture({ guestSeed: { grace: 1 } });
  const graceShot = grace.fire();
  grace.advance(1100);
  assert.equal(grace.claim(graceShot), false, 'rewound spawn protection persists');
  const expired = fixture();
  const oldShot = expired.fire();
  expired.advance(3000);
  assert.equal(expired.claim(oldShot), false);
  assert.equal(expired.authority.shots.has(oldShot.message.id), false);
  assert.equal(expired.fire(expired.host, { id: oldShot.message.id }).accepted, false, 'expired IDs remain tombstoned');
});

function geometricShot(weapon, overrides = {}) {
  return { id: 'geometry', ownerId: 'shooter', weapon, angle: 0, x: 100, y: 100,
    range: 660, damage: GUNS[weapon].damage, ...overrides };
}
function circle(id, x, y, hp = 100) {
  return { id, x, y, r: 13, hp, active: true, spawnVersion: 1, grace: 0 };
}

test('pistol/rifle reflect once, laser twice on walls only, and nailgun has fixed indexed spread', () => {
  const geometry = level({ walls: [{ x: 200, y: 0, w: 8, h: 400, hp: 35 }] });
  for (const weapon of ['pistol', 'rifle', 'laser']) {
    assert.equal(traceShot(geometricShot(weapon, { angle: Math.PI / 4 }),
      [circle('target', 150, 250)], geometry)[0]?.targetId, 'target');
  }
  geometry.walls.push({ x: 0, y: 300, w: 200, h: 8, hp: 35 });
  assert.equal(traceShot(geometricShot('pistol', { angle: Math.PI / 4 }), [circle('target', 50, 250)], geometry).length, 0);
  assert.equal(traceShot(geometricShot('laser', { angle: Math.PI / 4 }), [circle('target', 50, 250)], geometry).length, 1);
  assert.equal(traceShot(geometricShot('laser', { angle: Math.PI / 4 }), [circle('target', 150, 250)],
    level({ pillars: [geometry.walls[0]] })).length, 0);
  const pellets = traceShot(geometricShot('nailgun'), [circle('target', 200, 100)], level());
  assert.deepEqual(pellets.map(p => p.pellet), [0, 1, 2]);
  const f = fixture({ rules: { nailgun: true, playerMaxHp: 100 }, guestSeed: { x: 200 } });
  const shot = f.fire(f.host, { weapon: 'nailgun' });
  assert.equal(f.claim(shot, f.host, 'guest', 0), true);
  assert.equal(f.claim(shot, f.host, 'guest', 0), false);
  assert.equal(f.claim(shot, f.host, 'guest', 1), true);
  assert.equal(f.claim(shot, f.host, 'guest', 2), true);
  assert.equal(f.claim(shot, f.host, 'guest', 3), false);
  assert.equal(f.target.hp, 40);
});

test('gatling pierces walls for seven body widths, but not bodies, crates or pillars', () => {
  const wall = { x: 200, y: 0, w: 10, h: 200, hp: 35 };
  const geometry = level({ walls: [wall] });
  assert.equal(traceShot(geometricShot('gatling'), [circle('near', 380, 100)], geometry).length, 1);
  assert.equal(traceShot(geometricShot('gatling'), [circle('far', 420, 100)], geometry).length, 0);
  assert.deepEqual(traceShot(geometricShot('gatling'), [circle('near', 280, 100), circle('far', 350, 100)],
    geometry).map(h => h.targetId), ['near']);
  for (const kind of ['pillars', 'crates'])
    assert.equal(traceShot(geometricShot('gatling'), [circle('target', 300, 100)], level({ [kind]: [wall] })).length, 0);
});

test('rocket splash is anchored to the first impact (including map edge), not claimed target', () => {
  const geometry = level({ walls: [{ x: 200, y: 0, w: 10, h: 300, hp: 35 }] });
  assert.deepEqual(traceShot(geometricShot('rocket'), [circle('splash', 280, 130), circle('far', 400, 100)],
    geometry).map(h => h.targetId), ['splash']);
  const edge = level({ worldW: 300 });
  assert.equal(traceShot(geometricShot('rocket'), [circle('edgeSplash', 350, 220)], edge).length, 1);
  assert.equal(traceShot(geometricShot('pistol'), [circle('outside', 600, 100)], edge).length, 0);
});

test('katana validates blink corridor, sweep range, cover and single-hit deduplication', () => {
  const hits = traceShot(geometricShot('katana'), [circle('crossed', 170, 100, 500), circle('swept', 250, 100, 500)], level());
  assert.equal(hits.find(h => h.targetId === 'crossed').damage, 150);
  assert.equal(hits.find(h => h.targetId === 'swept').damage, 500);
  assert.equal(traceShot(geometricShot('katana'), [circle('far', 300, 100)], level()).length, 0);
  assert.equal(traceShot(geometricShot('katana'), [circle('behindWall', 180, 100)],
    level({ walls: [{ x: 150, y: 0, w: 8, h: 250, hp: 35 }] })).length, 0);
  const f = fixture({ guestSeed: { x: 170 } });
  const shot = f.fire(f.host, { weapon: 'katana' });
  assert.equal(shot.accepted, true);
  assert.equal(f.claim(shot), true, 'slash claims can immediately follow fire in the same callback');
  assert.equal(f.claim(shot), false);
});

test('movement consumes bounded credit, validates collision and seq, ignores caller HP and ping', () => {
  const f = fixture();
  assert.ok(f.input(f.host, { x: 180, hp: 999, deaths: 9, ping: 100000 }));
  assert.equal(f.player.x, 180);
  assert.equal(f.player.hp, 30);
  assert.equal(f.host.data.rtt, undefined);
  assert.equal(f.input(f.host, { x: 260 }), null, 'burst allowance does not replenish every input');
  assert.equal(f.player.x, 180);
  assert.equal(f.input(f.host, { seq: 1 }), null);
  assert.equal(f.input(f.host, { id: 'guest' }), null);
  assert.equal(f.input(f.host, { x: Infinity }), null);
  assert.equal(f.input(f.host, { x: -10000 }), null);
  const wall = fixture({ map: { walls: [{ x: 150, y: 100, w: 8, h: 200, hp: 35 }] } });
  assert.ok(wall.input(wall.host, { x: 200 }));
  assert.ok(wall.player.x <= 137);
});

test('fire immediately after tap dash uses finite shared movement credit and cannot cross hard cover', () => {
  const f = fixture();
  const tapShot = f.fire(f.host, { x: 230 });
  assert.equal(tapShot.accepted, true);
  assert.equal(f.player.x, 230);
  assert.equal(f.player.moveCredit, 0);
  assert.equal(f.claim(tapShot), true);
  assert.equal(f.input(f.host, { x: 350 }), null, 'fire origin consumed the same movement allowance');
  const wall = fixture({ map: { walls: [{ x: 160, y: 100, w: 8, h: 200, hp: 35 }] } });
  assert.equal(wall.fire(wall.host, { x: 230 }).accepted, false);
  assert.equal(wall.player.x, 100);
  const crate = fixture({ map: { crates: [{ x: 160, y: 190, w: 26, h: 26, hp: 1 }] } });
  assert.equal(crate.fire(crate.host, { x: 230 }).accepted, true);
  assert.equal(crate.authority.map.crates[0].hp, 0);
});

test('host snapshots strip actor authority, preserve bounded gear and environment without refreshing lastSeen', () => {
  const f = fixture({ enemies: [seed('enemy-0', 450, 200)] });
  f.advance(500);
  const message = f.authority.worldSnapshot({ type: 'playerState', seq: 1, snapshot: {
    round: 1, time: 500, started: true, player: { ...seed(CODE), x: 700, hp: 0, pvpKills: 999,
      hasStealth: true, stealthActive: true },
    players: [{ ...seed('guest'), hp: 0, lastSeen: f.now(), hasGatling: true }],
    enemies: [{ id: 'enemy-0', hp: 0 }], monster: { hp: 999 }, unknown: { players: [] },
    crates: [{ x: 400, y: 350, w: 26, h: 26, hp: 0 }],
    rules: { playerMaxHp: 1e9 },
  } });
  for (const key of ['player', 'players', 'enemies', 'monster', 'unknown']) assert.equal(key in message.snapshot, false);
  assert.equal(f.player.x, 100);
  assert.equal(f.player.hp, 30);
  assert.equal(f.player.pvpKills, 0);
  assert.equal(f.player.hasStealth, true);
  assert.equal(f.player.stealthActive, false, 'host cannot activate owner abilities');
  assert.equal(f.target.hasGatling, true);
  assert.equal(f.target.lastSeen, 10000);
  assert.equal(f.authority.enemies.get('enemy-0').hp, 3);
  assert.equal(message.snapshot.rules.playerMaxHp, 30);
  assert.equal(message.snapshot.crates[0].hp, 0);
  assert.deepEqual(sanitizeWorldSnapshot({ player: {}, enemies: [], monster: {}, time: 7 }), { time: 7 });
});

test('owner ability activation wins over stale host snapshots and obeys grants, duration and cooldown', () => {
  const f = fixture({ rules: { mode: 'challenge', stealthDuration: 2 } });
  f.input(f.guest, { stealthActive: true });
  assert.equal(f.target.stealthActive, false, 'unowned abilities cannot activate');
  f.authority.ingestGear({ players: [{ ...seed('guest'), hasStealth: true, hasSandevistan: true }] }, f.now());
  f.input(f.guest, { stealthActive: true, actions: { ability: 1 } });
  assert.equal(f.target.stealthActive, true);
  f.authority.ingestGear({ players: [{ ...seed('guest'), hasStealth: false, stealthActive: false,
    sandevistanActive: true, selectedAbility: 'sandevistan' }] }, f.now());
  assert.equal(f.target.hasStealth, true);
  assert.equal(f.target.stealthActive, true);
  assert.equal(f.target.sandevistanActive, false);
  f.advance(2100);
  assert.equal(f.target.stealthActive, false);
  f.input(f.guest, { stealthActive: true, actions: { ability: 1 } });
  assert.equal(f.target.stealthActive, false, 'repeated old true flag cannot restart elapsed ability');
  f.input(f.guest, { stealthActive: false, sandevistanActive: true, actions: { ability: 2 } });
  assert.equal(f.target.sandevistanActive, true);
  f.advance(15001);
  assert.equal(f.target.sandevistanActive, false);
  f.input(f.guest, { sandevistanActive: true, actions: { ability: 3 } });
  assert.equal(f.target.sandevistanActive, false, 'server enforces the eight-second cooldown');
  f.advance(8000);
  f.input(f.guest, { sandevistanActive: true, actions: { ability: 4 } });
  assert.equal(f.target.sandevistanActive, true);
  const own = fixture();
  own.authority.ingestGear({ player: { ...seed(CODE), hasStealth: true } }, own.now());
  own.input(own.host, { actions: { ability: 1 } });
  assert.equal(own.player.stealthActive, true, 'action-only host input also works');
  own.input(own.host, { actions: { ability: 1 } });
  assert.equal(own.player.stealthActive, true, 'repeated action seq does not toggle twice');
});

test('map openings retain bounded width and orientation for the frontend renderer', () => {
  const opening = { x: 220, y: 60, width: 42, vertical: true };
  const f = fixture({ map: { openings: [opening], rooms: [{ x: 0, y: 0, openings: [opening] }] } });
  assert.equal(f.authority.map.openings[0].width, 42);
  assert.equal(f.authority.map.openings[0].vertical, true);
  assert.equal(f.authority.map.rooms[0].openings[0].width, 42);
});

test('silence expires only after four seconds and owner heartbeat/input restores the same life', () => {
  const f = fixture();
  f.claim(f.fire());
  const life = f.target.spawnVersion, rev = f.target.rev;
  f.advance(4000);
  assert.equal(f.target.active, true);
  assert.equal(f.authority.actorSnapshot(f.target).silenceMs, 4000);
  f.authority.worldSnapshot({ seq: 1, snapshot: { round: 1,
    players: [{ ...seed('guest'), hp: 999, lastSeen: f.now() }] } });
  f.advance(1);
  assert.equal(f.target.active, false);
  f.advance(60);
  const update = f.host.sent.filter(p => p.message?.type === 'playerState').at(-1).message;
  assert.equal(update.players.some(p => p.id === 'guest'), false);
  f.authority.touch(f.guest, f.now());
  assert.equal(f.target.active, true);
  assert.equal(f.target.hp, 29);
  assert.equal(f.target.spawnVersion, life);
  assert.equal(f.target.rev, rev);
  f.advance(4001);
  assert.equal(f.target.active, false);
  assert.ok(f.input(f.guest));
  assert.equal(f.target.active, true);
  assert.equal(f.target.hp, 29);
});

test('revisions are present on both periodic streams; cadence is 60ms / 80ms with shared seq', () => {
  const f = fixture({ enemies: [seed('enemy-0', 500, 200)] });
  f.advance(59);
  assert.equal(f.host.sent.length, 0);
  f.advance(1);
  const players = f.host.sent.at(-1).message;
  assert.equal(players.type, 'playerState');
  assert.ok(players.players.every(p => Number.isInteger(p.rev) && Number.isFinite(p.lastSeen)));
  f.advance(20);
  const npcs = f.host.sent.at(-1).message;
  assert.equal(npcs.type, 'npcUpdate');
  assert.ok(npcs.seq > players.seq);
  assert.equal(npcs.enemies[0].rev, 1);
  assert.equal(npcs.timeScale, 1);
});

test('pickup healing requires prior registration, immutable position, owner, proximity, and consumes once', () => {
  const f = fixture();
  f.claim(f.fire());
  const drop = { id: 'drop-1', spawned: true, kind: 'special', ownerId: null,
    x: 300, y: 200, landed: true, claimed: false };
  f.authority.ingestDrops([{ ...drop, claimed: true, claimedById: 'guest' }], f.now());
  assert.equal(f.target.hp, 29);
  f.authority.ingestDrops([drop], f.now());
  f.advance(60);
  f.authority.ingestDrops([{ ...drop, claimed: true, claimedById: CODE }], f.now());
  assert.equal(f.authority.drops.get(drop.id).claimed, false, 'collector is too far');
  f.authority.ingestDrops([{ ...drop, x: 100, claimed: true, claimedById: CODE }], f.now());
  assert.equal(f.authority.drops.get(drop.id).claimed, false, 'drop position cannot change');
  const before = f.target.rev;
  f.authority.ingestDrops([{ ...drop, claimed: true, claimedById: 'guest' }], f.now());
  assert.equal(f.target.hp, 30);
  assert.equal(f.target.rewardCount, 1);
  assert.equal(f.target.rev, before + 1);
  f.target.hp = 20;
  f.authority.ingestDrops([{ ...drop, claimed: true, claimedById: 'guest' }], f.now());
  assert.equal(f.target.hp, 20);
  assert.equal(f.target.rewardCount, 1);
  const red = { ...drop, id: 'red', kind: 'red', ownerId: CODE };
  f.authority.ingestDrops([red], f.now());
  f.advance(60);
  f.authority.ingestDrops([{ ...red, claimed: true, claimedById: 'guest' }], f.now());
  assert.equal(f.target.hp, 20);
});

test('dash and slash break crates on server and stale host snapshots cannot restore them', () => {
  const crate = { x: 140, y: 190, w: 26, h: 26, hp: 1 };
  const f = fixture({ map: { crates: [crate] } });
  assert.ok(f.input(f.host, { x: 180, dash: true }));
  assert.equal(f.authority.map.crates[0].hp, 0);
  f.authority.worldSnapshot({ seq: 1, snapshot: { round: 1, crates: [crate] } });
  assert.equal(f.authority.map.crates[0].hp, 0);
  f.advance(80);
  assert.equal(f.host.sent.find(p => p.message?.type === 'npcUpdate').message.crates[0].hp, 0);
  const g = fixture({ map: { crates: [crate] } });
  assert.equal(g.fire(g.host, { weapon: 'katana' }).accepted, true);
  assert.equal(g.authority.map.crates[0].hp, 0);
});

test('NPC movement and firing are server-owned; only the local victim can claim NPC shots', () => {
  const f = fixture({ npcs: true, enemies: [seed('enemy-0', 100, 350)] });
  const npc = f.authority.enemies.get('enemy-0');
  const startX = npc.x, startY = npc.y;
  for (let i = 0; i < 15; i++) f.advance(80);
  const event = f.host.sent.find(p => p.message?.type === 'fireEvent');
  assert.equal(event.from, 'server');
  assert.equal(event.message.actorId, npc.id);
  assert.ok(npc.x !== startX || npc.y !== startY);
  assert.equal(f.fire(f.host, { actorId: npc.id }).accepted, false);
  assert.equal(f.claim(event.message.id, f.guest, CODE), false);
  const impact = f.authority.shots.get(event.message.id).impacts[0];
  assert.equal(impact.targetId, CODE);
  assert.equal(f.claim(event.message.id, f.host, CODE), true);
  assert.equal(f.player.hp, 29);
  assert.equal(f.claim(event.message.id, f.host, CODE), false);
});

test('Sandevistan slows NPC AI and claim travel using server time, not supplied timeScale', () => {
  const f = fixture({ enemies: [seed('enemy-0', 100, 400)] });
  const npc = f.authority.enemies.get('enemy-0');
  f.authority.ingestGear({ player: { ...seed(CODE), hasSandevistan: true, sandevistanActive: true } }, f.now());
  f.input(f.host, { sandevistanActive: true });
  const shot = f.authority.storeShot(npc, { id: 'server:test', weapon: 'pistol', x: 100, y: 400, angle: -Math.PI / 2 });
  f.advance(400);
  assert.equal(f.authority.timeScale, 0.2);
  assert.equal(f.authority.npcClock, 80);
  assert.equal(f.claim(shot.id, f.host, CODE, 0, { timeScale: 1 }), false);
  f.advance(800);
  assert.equal(f.claim(shot.id, f.host, CODE), true);
});

test('boss spawn, damage, corpse time, alternating drops and NPC kill rewards are authoritative', () => {
  const f = fixture({ enemies: Array.from({ length: 10 }, (_, i) => seed(`enemy-${i}`, 300 + i * 25, 400)) });
  f.player.hp = 10;
  for (const npc of f.authority.enemies.values()) f.authority.applyDamage(npc, 100, f.player, 'test');
  assert.equal(f.player.enemyKills, 10);
  assert.equal(f.player.hp, 30);
  assert.equal(f.host.sent.filter(p => p.message?.type === 'dropNotice' && p.message.kind === 'red').length, 1);
  assert.equal(f.guest.sent.some(p => p.message?.type === 'dropNotice'), false);
  for (let tier = 0; tier < 2; tier++) {
    assert.equal(f.authority.spawnMonster(f.now()), true);
    const boss = f.authority.monster;
    assert.equal(boss.maxHp, tier === 0 ? 400 : 2000);
    const snap = f.authority.actorSnapshot(boss);
    assert.equal(snap.boss, true);
    assert.equal(snap.r, 52);
    f.authority.applyDamage(boss, boss.hp, f.player, 'boss');
    assert.equal(boss.deadAt, f.authority.time);
    const notice = f.host.sent.filter(p => p.message?.kind === 'chip').at(-1).message;
    assert.equal(notice.ability, tier ? 'stealth' : 'sandevistan');
    f.advance(5100);
    f.authority.touch(f.host, f.now());
    assert.equal(f.authority.monster, null);
  }
  assert.equal(fixture({ rules: { combat: 'pvp' } }).authority.spawnMonster(10000), false);
  assert.equal(fixture({ map: { mapType: 'desert' } }).authority.spawnMonster(10000), false);
});

test('history and shot registries remain bounded, independent per-type rate buckets refill', () => {
  const f = fixture();
  for (let i = 0; i < 1200; i++) {
    f.advance(10, false);
    f.authority.touch(f.host, f.now());
  }
  const history = f.authority.history.get(CODE);
  assert.ok(history.length <= CONSTANTS.MAX_HISTORY);
  assert.ok(history[1].at >= f.now() - CONSTANTS.HISTORY_MS);
  for (let i = 0; i < CONSTANTS.MAX_SHOTS + 8; i++) {
    f.advance(220, false);
    f.authority.touch(f.host, f.now());
    f.fire();
  }
  assert.equal(f.authority.shots.size, CONSTANTS.MAX_SHOTS);
  assert.equal(f.authority.shotClaims.size, CONSTANTS.MAX_SHOTS);
  const data = {};
  for (let i = 0; i < RATE_LIMITS.fireEvent[1]; i++) assert.equal(takeRate(data, 'fireEvent', 0), true);
  assert.equal(takeRate(data, 'fireEvent', 0), false);
  assert.equal(takeRate(data, 'input', 0), true);
  assert.equal(takeRate(data, 'heartbeat', 0), true);
  assert.equal(takeRate(data, 'fireEvent', 1000), true);
  assert.equal(takeRate(data, 'unknown', 1000), false);
  for (const malformed of ['__proto__', 'constructor', 'toString', { toString: null }])
    assert.equal(takeRate(data, malformed, 1000), false);
  assert.equal(f.input(f.host, { weapon: { toString: null } }), null);
});

function once(emitter, event, accepts = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timeout: ${event}`)); }, 3000);
    const listener = value => {
      if (!accepts(value)) return;
      clearTimeout(timer); emitter.off(event, listener); resolve(value);
    };
    emitter.on(event, listener);
  });
}
async function waitFor(check) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timeout');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function networkFixture(t) {
  let time = 10000;
  const relay = createRelay({ now: () => time, autoTick: false, npcs: false });
  const sockets = [];
  t.after(async () => { for (const socket of sockets) socket.disconnect(); await relay.close(); });
  await new Promise((resolve, reject) => {
    relay.server.once('error', reject);
    relay.server.listen(0, '127.0.0.1', resolve);
  });
  const address = `http://127.0.0.1:${relay.server.address().port}`;
  const connect = async (code, expectError = false) => {
    const socket = clientIo(address, { autoConnect: false, forceNew: true, reconnection: false,
      transports: ['websocket'], auth: code ? { roomCode: code } : {} });
    sockets.push(socket);
    socket.packets = [];
    socket.on('game-message', packet => socket.packets.push(packet));
    const ready = once(socket, expectError ? 'relay-error' : 'registered');
    socket.connect();
    const registration = await ready;
    return { socket, registration };
  };
  const host = (await connect(CODE)).socket;
  return { relay, address, host, connect,
    advance(ms) { time += ms; relay.tick(); }, now: () => time,
    async join() {
      const { socket } = await connect();
      const open = once(socket, 'channel-open');
      socket.emit('join-room', CODE);
      assert.equal(await open, CODE);
      return socket;
    },
    send(socket, message, target) { socket.emit('relay', { ...(target ? { target } : {}), message }); },
  };
}

test('Socket.IO integration: zero-guest init, targeted maps, sanitation, ownership, ping and room isolation', async t => {
  const n = await networkFixture(t);
  assert.equal((await fetch(n.address + '/health')).status, 200);
  assert.equal((await fetch(n.address)).status, 200);
  assert.equal((await fetch(n.address + '/socket.io/socket.io.js')).status, 200);
  assert.equal((await fetch(n.address + '/not-found')).status, 404);
  const map = level();
  const snapshot = { round: 1, started: true, rules: { combat: 'pvp' }, player: seed(CODE), players: [] };
  n.send(n.host, { type: 'map', map, snapshot });
  const room = n.relay.rooms.get(CODE);
  await waitFor(() => room.authority);
  const authority = room.authority;
  assert.equal(authority.players.size, 1);
  const challenge = n.host.packets.find(p => p.message.type === 'ping').message;
  n.advance(120);
  const pong = once(n.host, 'game-message', p => p.message.type === 'ping' && 'rtt' in p.message);
  n.send(n.host, { type: 'ping', nonce: challenge.nonce, rtt: 999999, timestamp: -10000 });
  assert.equal((await pong).message.rtt, 120);
  assert.equal(room.host.data.rtt, 120);
  n.send(n.host, { type: 'ping', nonce: challenge.nonce });
  const guest = await n.join();
  const guestMap = once(guest, 'relay', p => p.message.type === 'map');
  n.send(n.host, { type: 'map', map, localId: guest.id, snapshot: { ...snapshot,
    player: { ...snapshot.player, hp: 99999, x: 700 }, players: [seed(guest.id, 300)] } }, guest.id);
  const patched = (await guestMap).message;
  assert.equal(room.authority, authority);
  assert.equal(patched.snapshot.player.hp, 30);
  assert.equal(patched.snapshot.player.x, 100);
  assert.equal(patched.snapshot.players.find(p => p.id === guest.id).rev, 1);
  const input = once(n.host, 'relay', p => p.message.input?.seq === 1);
  n.send(guest, { type: 'playerState', round: 1, input: {
    seq: 1, x: 300, y: 200, angle: Math.PI, weapon: 'pistol', spawnVersion: 1, hp: 0, ping: 9999,
  } });
  assert.equal((await input).from, guest.id);
  assert.equal(authority.players.get(guest.id).hp, 30);
  const world = once(guest, 'relay', p => p.message.snapshot?.time === 8);
  n.send(n.host, { type: 'playerState', seq: 1, snapshot: { ...snapshot, time: 8,
    players: [seed(guest.id, 800, 300, { hp: 0 })], enemies: [{ hp: 0 }], monster: { hp: 999 } } });
  const broadcast = await world;
  assert.equal(broadcast.from, CODE);
  for (const field of ['player', 'players', 'enemies', 'monster']) assert.equal(field in broadcast.message.snapshot, false);
  const fireMessage = { type: 'fireEvent', id: `${guest.id}:1`, actorId: guest.id, round: 1, spawnVersion: 1,
    weapon: 'pistol', x: 300, y: 200, angle: Math.PI, timestamp: -1e12 };
  const fire = once(n.host, 'game-message', p => p.message.type === 'fireEvent');
  n.send(guest, fireMessage);
  assert.equal((await fire).message.shotId, fireMessage.id);
  const confirm = once(n.host, 'game-message', p => p.message.type === 'killConfirm');
  n.send(guest, { type: 'hitClaim', round: 1, fireId: fireMessage.id, targetId: CODE, pellet: 0 });
  assert.equal((await confirm).message.target.hp, 29);
  n.send(n.host, { type: 'map', map, snapshot });
  const outsider = (await n.connect()).socket;
  n.send(outsider, { ...fireMessage, id: 'outsider', actorId: CODE }, CODE);
  n.send(guest, { ...fireMessage, id: 'spoof', actorId: CODE });
  n.send(n.host, { ...fireMessage, id: 'host-spoof', actorId: 'enemy-0' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(authority.players.get(CODE).hp, 29, 'same-round map cannot reset life');
  assert.equal(authority.shots.has('outsider'), false);
  assert.equal(authority.shots.has('spoof'), false);
  assert.equal(authority.shots.has('host-spoof'), false);
  n.send(guest, { type: '__proto__' });
  n.send(guest, { type: 'constructor' });
  n.send(guest, { type: { toString: null } });
  n.send(guest, { type: 'playerState', round: 1, input: {
    seq: 2, x: 300, y: 200, angle: 0, spawnVersion: 1, weapon: { toString: null },
  } });
  assert.equal((await n.connect(CODE, true)).registration.type, 'room-unavailable');
  const missing = once(outsider, 'relay-error');
  outsider.emit('join-room', 'missing');
  assert.equal((await missing).type, 'room-not-found');
  const close = once(guest, 'channel-close');
  n.host.disconnect();
  assert.equal(await close, CODE);
  assert.equal(n.relay.rooms.size, 0);
  assert.equal((await n.connect(CODE)).registration.id, CODE);
});

test('Socket.IO integration: first targeted round-zero lobby initializes without combat, then new round replaces it', async t => {
  const n = await networkFixture(t);
  const guest = await n.join();
  const map = level({ enemies: [seed('enemy-0', 400)] });
  const lobby = { round: 0, started: false, rules: { combat: 'pvevp' },
    player: seed(CODE), players: [seed(guest.id, 300)] };
  const opened = once(guest, 'relay', p => p.message.type === 'map');
  n.send(n.host, { type: 'map', map, snapshot: lobby, localId: guest.id }, guest.id);
  assert.equal((await opened).message.snapshot.round, 0);
  const room = n.relay.rooms.get(CODE), previous = room.authority;
  n.send(n.host, { type: 'fireEvent', id: 'lobby-shot', actorId: CODE, round: 0,
    spawnVersion: 1, x: 100, y: 200, weapon: 'pistol', angle: 0, timestamp: n.now() });
  n.advance(80);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(previous.time, 0);
  assert.equal(previous.shots.size, 0);
  const started = { ...lobby, round: 1, started: true, rules: { combat: 'pvp', playerMaxHp: 80 } };
  n.send(n.host, { type: 'map', map, snapshot: started });
  await waitFor(() => room.authority !== previous);
  assert.equal(room.authority.round, 1);
  assert.equal(room.authority.players.get(CODE).hp, 80);
  assert.equal(room.authority.enemies.size, 0);
  n.send(n.host, { type: 'map', map, snapshot: lobby });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(room.authority.round, 1);
});
