'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Server } = require('socket.io');

// Keep these values and the collision primitives in sync with the single-player game.
const GUNS = Object.freeze(Object.fromEntries(Object.entries({
  pistol: { damage: 1, interval: 0.22, speed: 850 },
  rifle: { damage: 2, interval: 0.075, speed: 1050 },
  gatling: { damage: 2, interval: 0.025, speed: 1200 },
  nailgun: { damage: 20, interval: 0.34, speed: 680 },
  rocket: { damage: 90, interval: 0.6, speed: 470 },
  laser: { damage: 95, interval: 0.16, speed: 4200 },
  katana: { damage: 150, interval: 0.42, speed: 0 },
}).map(([name, gun]) => [name, Object.freeze(gun)])));
const CONSTANTS = Object.freeze({
  BORDER: 70, BODY_WIDTH: 26, RADIUS: 13, WALK_SPEED: 120, DASH_SPEED: 360,
  SWORD_RANGE: 52, SLASH_BLINK_DISTANCE: 104, ROCKET_BLAST_RADIUS: 130,
  HISTORY_MS: 2000, MAX_HISTORY: 256, MAX_SHOTS: 4096, SHOT_TTL_MS: 6000,
  PLAYER_INTERVAL_MS: 60, NPC_INTERVAL_MS: 80, SILENCE_MS: 4000,
  PING_INTERVAL_MS: 1500, GRACE_MS: 1600, MAX_DROPS: 2048,
});
const RATE_LIMITS = Object.freeze({
  map: [4, 16], input: [30, 45], world: [140, 160], fireEvent: [60, 80],
  hitClaim: [180, 240], heartbeat: [2, 4], ping: [2, 4],
  join: [2, 4], leave: [2, 4], reject: [8, 16], channel: [4, 8],
});
const GEAR_FLAGS = ['hasStealth', 'hasSandevistan', 'hasGatling', 'hasNailgun'];
const WORLD_FIELDS = ['started', 'paused', 'ended', 'won', 'lost', 'time', 'hostPing',
  'airdrops', 'chipDrops', 'walls', 'crates', 'pillars', 'globalAlert'];
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const finite = (n, fallback = 0) => Number.isFinite(n) ? n : fallback;
const integer = (n, fallback = 0) => Number.isSafeInteger(n) && n >= 0 ? n : fallback;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 100 && !/[\x00-\x1f]/.test(id);
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const wallActive = wall => wall.hp == null || wall.hp > 0;
const members = room => [room.host, ...room.guests.values()];
const ownerId = socket => socket.data.host ? socket.data.room : socket.id;

function takeRate(data, type, now) {
  if (typeof type !== 'string' || !Object.hasOwn(RATE_LIMITS, type)) return false;
  const limits = RATE_LIMITS[type];
  if (!data.limits) data.limits = new Map();
  const [rate, capacity] = limits;
  const bucket = data.limits.get(type) || { at: now, tokens: capacity };
  bucket.tokens = Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.at) * rate / 1000);
  bucket.at = now;
  data.limits.set(type, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens--;
  return true;
}

function circleRect(x, y, r, rect) {
  const dx = x - clamp(x, rect.x, rect.x + rect.w);
  const dy = y - clamp(y, rect.y, rect.y + rect.h);
  return dx * dx + dy * dy < r * r;
}

// Exact slab normals are also used by reflected and wall-piercing shots.
function rayRect(ox, oy, dx, dy, max, rect) {
  let near = 0, far = max, nx = 0, ny = 0;
  for (const axis of [0, 1]) {
    const o = axis ? oy : ox, d = axis ? dy : dx;
    const min = axis ? rect.y : rect.x, end = min + (axis ? rect.h : rect.w);
    if (Math.abs(d) < 1e-9) {
      if (o < min || o > end) return null;
      continue;
    }
    let a = (min - o) / d, b = (end - o) / d, sign = -1;
    if (a > b) { [a, b] = [b, a]; sign = 1; }
    if (a >= near) { near = a; nx = axis ? 0 : sign; ny = axis ? sign : 0; }
    far = Math.min(far, b);
    if (near > far) return null;
  }
  if (far < 0 || near > max) return null;
  if (nx === 0 && ny === 0) {
    if (Math.abs(dx) >= Math.abs(dy)) nx = -Math.sign(dx);
    else ny = -Math.sign(dy);
  }
  return { distance: Math.max(0, near), nx, ny };
}

function rayCircle(ox, oy, dx, dy, max, actor) {
  const rx = ox - actor.x, ry = oy - actor.y, projected = rx * dx + ry * dy;
  const c = rx * rx + ry * ry - actor.r * actor.r;
  if (c <= 0) return { distance: 0 };
  const discriminant = projected * projected - c;
  if (discriminant < 0) return null;
  const distance = -projected - Math.sqrt(discriminant);
  return distance >= 0 && distance <= max ? { distance } : null;
}

function cast(geometry, actors, ox, oy, dx, dy, max, shooterId, ignored = new Set()) {
  let result = null, limit = max;
  function accept(hit, item, kind) {
    // Solid cover wins exact ties with actors.
    if (hit && (!result || hit.distance < limit - 1e-7)) {
      limit = hit.distance; result = { ...hit, object: item, kind };
    }
  }
  const tx = Math.abs(dx) < 1e-9 ? Infinity : ((dx > 0 ? geometry.worldW + 70 : -70) - ox) / dx;
  const ty = Math.abs(dy) < 1e-9 ? Infinity : ((dy > 0 ? geometry.worldH + 70 : -70) - oy) / dy;
  const edge = Math.min(tx, ty);
  if (Number.isFinite(edge) && edge >= 0 && edge <= max)
    accept({ distance: edge }, null, 'boundary');
  for (const wall of geometry.walls) if (wallActive(wall) && !ignored.has(wall))
    accept(rayRect(ox, oy, dx, dy, limit, wall), wall, 'wall');
  for (const pillar of geometry.pillars) accept(rayRect(ox, oy, dx, dy, limit, pillar), pillar, 'pillar');
  for (const crate of geometry.crates) if (crate.hp > 0 && !ignored.has(crate))
    accept(rayRect(ox, oy, dx, dy, limit, crate), crate, 'crate');
  for (const actor of actors) if (actor.id !== shooterId && actor.hp > 0 && actor.active !== false)
    accept(rayCircle(ox, oy, dx, dy, limit, actor), actor, 'actor');
  return result;
}

function lineClear(geometry, ax, ay, bx, by, ignored) {
  const distance = Math.hypot(bx - ax, by - ay);
  return distance < 0.01 || !cast(geometry, [], ax, ay, (bx - ax) / distance,
    (by - ay) / distance, distance - 0.01, null, ignored);
}

function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(x - ax - dx * t, y - ay - dy * t);
}

function sampleHistory(history, time) {
  if (!history?.length || time < history[0].at) return null;
  let before = history[0], after;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].at <= time) { before = history[i]; after = history[i + 1]; break; }
  }
  const result = { ...before, grace: Math.max(0, (before.graceUntil - time) / 1000) };
  if (after && before.spawnVersion === after.spawnVersion && before.active === after.active) {
    const t = (time - before.at) / (after.at - before.at);
    result.x += (after.x - before.x) * t;
    result.y += (after.y - before.y) * t;
    result.angle += angleDelta(after.angle, before.angle) * t;
  }
  return result;
}

function slashPath(shot, geometry) {
  const dx = Math.cos(shot.angle), dy = Math.sin(shot.angle), r = CONSTANTS.RADIUS;
  let x = shot.x, y = shot.y;
  const ignored = new Set();
  for (let i = 0; i < 12; i++) {
    const nx = x + dx * CONSTANTS.SLASH_BLINK_DISTANCE / 12;
    const ny = y + dy * CONSTANTS.SLASH_BLINK_DISTANCE / 12;
    if (geometry.walls.some(o => wallActive(o) && circleRect(nx, ny, r, o)) ||
        geometry.pillars.some(o => circleRect(nx, ny, r, o)) ||
        nx < -70 + r || ny < -70 + r || nx > geometry.worldW + 70 - r || ny > geometry.worldH + 70 - r) break;
    for (const crate of geometry.crates) if (circleRect(nx, ny, r, crate)) ignored.add(crate);
    x = nx; y = ny;
  }
  return { x, y, ignored };
}

function traceKatana(shot, scene, geometry) {
  const dx = Math.cos(shot.angle), dy = Math.sin(shot.angle), r = CONSTANTS.RADIUS;
  const { x, y, ignored } = slashPath(shot, geometry);
  const moved = Math.hypot(x - shot.x, y - shot.y), hits = [];
  for (const actor of scene) {
    if (actor.id === shot.ownerId || actor.hp <= 0 || actor.active === false) continue;
    const along = (actor.x - shot.x) * dx + (actor.y - shot.y) * dy;
    const crossed = moved > 0 && along >= 0 && along <= moved &&
      segmentDistance(actor.x, actor.y, shot.x, shot.y, x, y) <= r + actor.r;
    const range = Math.hypot(actor.x - x, actor.y - y);
    const swept = range <= CONSTANTS.SWORD_RANGE &&
      Math.abs(angleDelta(Math.atan2(actor.y - y, actor.x - x), shot.angle)) <= 1.41 &&
      lineClear(geometry, x, y, actor.x, actor.y, ignored);
    if ((crossed || swept) && lineClear({ ...geometry, crates: [] }, shot.x, shot.y,
      crossed ? actor.x : x, crossed ? actor.y : y)) {
      hits.push({ targetId: actor.id, spawnVersion: actor.spawnVersion, pellet: 0,
        grace: actor.grace, distance: crossed ? along : moved + range,
        damage: crossed ? GUNS.katana.damage : actor.hp });
    }
  }
  return hits;
}

function traceShot(shot, scene, geometry) {
  if (shot.weapon === 'katana') return traceKatana(shot, scene, geometry);
  const hits = [], angles = shot.weapon === 'nailgun' ? [-0.075, 0, 0.075] : [0];
  for (let pellet = 0; pellet < angles.length; pellet++) {
    let x = shot.x, y = shot.y, dx = Math.cos(shot.angle + angles[pellet]);
    let dy = Math.sin(shot.angle + angles[pellet]), remaining = shot.range, traveled = 0, bounces = 0;
    const pierced = new Set();
    for (let pass = 0; pass < 24 && remaining > 0.001; pass++) {
      const hit = cast(geometry, scene, x, y, dx, dy, remaining, shot.ownerId, pierced);
      const distance = hit ? hit.distance : remaining;
      x += dx * distance; y += dy * distance; remaining -= distance; traveled += distance;
      if (shot.weapon === 'rocket') {
        for (const actor of scene) if (actor.id !== shot.ownerId && actor.hp > 0 && actor.active !== false &&
          Math.hypot(actor.x - x, actor.y - y) <= CONSTANTS.ROCKET_BLAST_RADIUS) {
          hits.push({ targetId: actor.id, spawnVersion: actor.spawnVersion, pellet, grace: actor.grace,
            distance: traveled, damage: shot.damage });
        }
        break;
      }
      if (!hit) break;
      if (shot.weapon === 'gatling' && hit.kind === 'wall') {
        if (!pierced.size) {
          const rect = hit.object;
          const tx = Math.abs(dx) < 1e-9 ? Infinity : ((dx > 0 ? rect.x + rect.w : rect.x) - x) / dx;
          const ty = Math.abs(dy) < 1e-9 ? Infinity : ((dy > 0 ? rect.y + rect.h : rect.y) - y) / dy;
          remaining = Math.min(remaining, Math.max(0, Math.min(tx, ty)) + CONSTANTS.BODY_WIDTH * 7);
        }
        pierced.add(hit.object);
        continue;
      }
      if (hit.kind === 'actor') {
        hits.push({ targetId: hit.object.id, spawnVersion: hit.object.spawnVersion, pellet,
          grace: hit.object.grace, distance: traveled, damage: shot.damage });
        break;
      }
      const reflectable = shot.weapon === 'laser' ? hit.kind === 'wall' :
        shot.weapon !== 'gatling' && (hit.kind === 'pillar' || hit.kind === 'wall' && shot.weapon !== 'nailgun');
      if (!reflectable || bounces >= (shot.weapon === 'laser' ? 2 : 1)) break;
      const dot = dx * hit.nx + dy * hit.ny;
      dx -= 2 * dot * hit.nx; dy -= 2 * dot * hit.ny;
      x += hit.nx * 0.05; y += hit.ny * 0.05;
      remaining -= 0.05; traveled += 0.05; bounces++;
    }
  }
  return hits;
}

function sanitizeRules(raw = {}, mapType) {
  return Object.freeze({
    combat: raw.combat === 'pvp' ? 'pvp' : 'pvevp',
    mapType, mode: raw.mode === 'challenge' ? 'challenge' : 'infinite',
    enemyCount: clamp(integer(raw.enemyCount, 72), 0, 144),
    playerMaxHp: clamp(finite(raw.playerMaxHp, 30), 1, 10000),
    challengeRespawns: clamp(integer(raw.challengeRespawns, 3), 0, 100),
    playerDamageMultiplier: clamp(finite(raw.playerDamageMultiplier, 1), 0.1, 100),
    enemyDamageMultiplier: clamp(finite(raw.enemyDamageMultiplier, 1), 0.1, 100),
    stealthDuration: clamp(finite(raw.stealthDuration, 20), 0, 100),
    dashDuration: clamp(finite(raw.dashDuration, 10), 0, 100),
    laser: raw.laser === true, nailgun: raw.nailgun === true, gatling: raw.gatling === true,
  });
}

function sanitizeRects(value, kind, dimensions, max) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid geometry');
  return value.map(rect => {
    if (!object(rect) || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) ||
      rect.w <= 0 || rect.h <= 0 || rect.x < -140 || rect.y < -140 ||
      rect.x + rect.w > dimensions.worldW + 140 || rect.y + rect.h > dimensions.worldH + 140)
      throw new Error('Invalid rectangle');
    const copy = { x: rect.x, y: rect.y, w: rect.w, h: rect.h, kind };
    if (kind !== 'pillar') {
      copy.hp = rect.hp == null && kind === 'wall' ? null : clamp(finite(rect.hp, 1), 0, 10000);
      copy.maxHp = clamp(finite(rect.maxHp, copy.hp || 35), 1, 10000);
    }
    for (const flag of ['vine', 'shrub', 'tumbleweed', 'cactus']) if (rect[flag] === true) copy[flag] = true;
    if (Number.isSafeInteger(rect.room)) copy.room = clamp(rect.room, 0, 143);
    return Object.freeze(copy);
  });
}

function sanitizeMap(raw) {
  if (!object(raw) || ![raw.worldW, raw.worldH, raw.roomW, raw.roomH].every(Number.isFinite) ||
    raw.worldW < 100 || raw.worldH < 100 || raw.worldW > 12000 || raw.worldH > 12000 ||
    raw.roomW < 100 || raw.roomH < 100 || raw.roomW > 1000 || raw.roomH > 1000)
    throw new Error('Invalid map dimensions');
  const map = {
    worldW: raw.worldW, worldH: raw.worldH, roomW: raw.roomW, roomH: raw.roomH,
    cols: clamp(integer(raw.cols, Math.ceil(raw.worldW / raw.roomW)), 1, 24),
    rows: clamp(integer(raw.rows, Math.ceil(raw.worldH / raw.roomH)), 1, 24),
    mapType: ['rooms', 'rainforest', 'desert'].includes(raw.mapType) ? raw.mapType : 'rooms',
  };
  map.walls = sanitizeRects(raw.walls, 'wall', map, 4096);
  map.pillars = sanitizeRects(raw.pillars, 'pillar', map, 1024);
  map.crates = sanitizeRects(raw.crates, 'crate', map, 2048);
  const opening = hole => ({
    x: clamp(finite(hole.x), -70, map.worldW + 70), y: clamp(finite(hole.y), -70, map.worldH + 70),
    width: clamp(finite(hole.width, 40), 0, 1000), vertical: hole.vertical === true,
    w: clamp(finite(hole.w, 40), 0, 1000), h: clamp(finite(hole.h, 40), 0, 1000),
  });
  map.rooms = (Array.isArray(raw.rooms) ? raw.rooms : []).slice(0, 144).filter(object).map(room => ({
    x: clamp(finite(room.x), 0, map.worldW), y: clamp(finite(room.y), 0, map.worldH),
    col: clamp(integer(room.col), 0, map.cols - 1), row: clamp(integer(room.row), 0, map.rows - 1),
    openings: (Array.isArray(room.openings) ? room.openings : []).slice(0, 8).filter(object).map(opening),
    initialCrates: clamp(integer(room.initialCrates), 0, 100),
    initialEnemies: clamp(integer(room.initialEnemies), 0, 144),
  }));
  map.openings = (Array.isArray(raw.openings) ? raw.openings : []).slice(0, 4096).filter(object).map(opening);
  return map;
}

function sanitizeWorldSnapshot(raw) {
  if (!object(raw)) return {};
  return Object.fromEntries(WORLD_FIELDS.filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]));
}

class RoundAuthority {
  constructor(room, rawMap, snapshot, options = {}) {
    this.room = room;
    this.now = options.now || Date.now;
    this.random = options.random || Math.random;
    this.npcsEnabled = options.npcs !== false;
    this.map = sanitizeMap(rawMap);
    this.rules = sanitizeRules(object(snapshot.rules) ? snapshot.rules : {}, this.map.mapType);
    if (!Number.isSafeInteger(snapshot.round) || snapshot.round < 0) throw new Error('Invalid round');
    this.round = snapshot.round;
    this.createdAt = this.now();
    this.lastTick = this.createdAt;
    this.lastPlayers = this.createdAt;
    this.lastNpcs = this.createdAt;
    this.time = 0;
    this.seq = 0;
    this.worldSeq = -1;
    this.started = snapshot.started !== false;
    this.paused = false;
    this.ended = false;
    this.entities = new Map();
    this.players = new Map();
    this.enemies = new Map();
    this.history = new Map();
    this.shots = new Map();
    this.shotClaims = new Map();
    this.seenShots = new Map();
    this.drops = new Map();
    this.monster = null;
    this.monsterTier = 0;
    this.nextMonsterAt = 60;
    this.serverFireSeq = 0;
    this.destroyedCrates = new Set();
    this.environmentDirty = false;
    this.npcClock = 0;
    this.timeScale = 1;
    const seeds = Array.isArray(snapshot.players) ? snapshot.players : [];
    const hostSeed = seeds.find(p => p?.id === room.code) ||
      (snapshot.player?.id === room.code ? snapshot.player : null);
    if (!hostSeed) throw new Error('Host actor missing');
    this.register(room.host, hostSeed, true);
    for (const [id, socket] of room.guests) {
      const seed = seeds.find(p => p?.id === id);
      if (seed) this.register(socket, seed, true);
    }
    if (this.rules.combat === 'pvevp' && this.map.mapType !== 'desert') {
      const seeds = Array.isArray(snapshot.enemies) ? snapshot.enemies : rawMap.enemies;
      for (const [index, seed] of (Array.isArray(seeds) ? seeds : []).slice(0, 144).entries()) {
        if (!object(seed)) continue;
        const id = /^enemy-[a-zA-Z0-9_-]{1,70}$/.test(seed.id) ? seed.id : `enemy-${index}`;
        if (this.entities.has(id)) continue;
        const weapon = ['pistol', 'rifle', 'rocket'].includes(seed.weapon) ? seed.weapon : 'pistol';
        const hp = weapon === 'rifle' ? 10 : 3;
        const actor = this.newActor(id, 'npc', seed, hp);
        actor.weapon = weapon;
        actor.wait = this.random() * 2;
        actor.room = clamp(integer(seed.room), 0, 143);
        this.enemies.set(id, actor);
        this.entities.set(id, actor);
        this.record(actor, this.createdAt);
      }
    }
    this.ingestDrops(snapshot.airdrops, this.createdAt);
  }

  socketFor(id) { return id === this.room.code ? this.room.host : this.room.guests.get(id); }
  emit(message, except) {
    for (const socket of members(this.room)) if (socket !== except && socket.connected !== false)
      socket.emit('game-message', { from: 'server', message });
  }
  packet(type, fields = {}) {
    return { type, round: this.round, seq: ++this.seq, serverTime: this.now(), ...fields };
  }
  hostNotice(fields) {
    this.room.host.emit('game-message', { from: 'server', message: this.packet('dropNotice', fields) });
  }

  inBounds(x, y, r) {
    return x >= -70 + r && y >= -70 + r &&
      x <= this.map.worldW + 70 - r && y <= this.map.worldH + 70 - r;
  }
  blocked(x, y, r, dash = false) {
    return !this.inBounds(x, y, r) ||
      this.map.walls.some(o => wallActive(o) && circleRect(x, y, r, o)) ||
      this.map.pillars.some(o => circleRect(x, y, r, o)) ||
      !dash && this.map.crates.some(o => o.hp > 0 && !o.shrub && circleRect(x, y, r, o));
  }

  safeSpawn(actor, preferred) {
    const radius = actor.r, points = [];
    if (preferred && [preferred.x, preferred.y].every(Number.isFinite) &&
      !this.blocked(preferred.x, preferred.y, radius) &&
      !this.map.crates.some(o => o.hp > 0 && circleRect(preferred.x, preferred.y, radius, o))) return { x: preferred.x, y: preferred.y };
    for (const room of this.map.rooms) points.push({ x: room.x + this.map.roomW / 2, y: room.y + this.map.roomH / 2 });
    // A fixed search budget keeps maliciously packed maps from blocking the event loop.
    const spacing = Math.max(radius * 2 + 4, Math.sqrt(this.map.worldW * this.map.worldH / 3500));
    for (let y = radius; y <= this.map.worldH - radius && points.length < 4096; y += spacing)
      for (let x = radius; x <= this.map.worldW - radius && points.length < 4096; x += spacing) points.push({ x, y });
    const threats = [...this.entities.values()].filter(a => a !== actor && a.active && a.hp > 0);
    let best = null, bestScore = -Infinity;
    for (const point of points) {
      if (this.blocked(point.x, point.y, radius) ||
        this.map.crates.some(o => o.hp > 0 && circleRect(point.x, point.y, radius, o))) continue;
      const score = Math.min(10000, ...threats.map(a => Math.hypot(a.x - point.x, a.y - point.y) - a.r - radius));
      if (score > bestScore) { best = point; bestScore = score; }
    }
    return best;
  }

  newActor(id, kind, seed, maxHp) {
    const now = this.now();
    const actor = {
      id, kind, r: kind === 'player' ? 13 : kind === 'boss' ? 52 : 12,
      hp: maxHp, maxHp, rev: 1, spawnVersion: clamp(integer(seed.spawnVersion, kind === 'player' ? 1 : 0), 0, 1000000),
      deaths: 0, enemyKills: 0, pvpKills: 0, shotsFired: 0, rewardCount: 0,
      angle: angleDelta(finite(seed.angle), 0), weapon: 'pistol', walk: 0,
      graceUntil: now + (kind === 'player' ? clamp(finite(seed.grace, 1.6), 0, 1.6) * 1000 : 0),
      ack: 0, lastSeen: now, lastMoveAt: now, moveCredit: 130, nextFireAt: now,
      active: true, expired: false, dead: false, deadAt: null, state: 'patrol',
      alert: 0, lost: 0, wait: 0, cooldown: 0, hitUntil: 0, muzzleUntil: 0,
      hasStealth: false, hasSandevistan: false, hasGatling: this.rules.gatling,
      hasNailgun: this.rules.nailgun, selectedAbility: null, stealthActive: false, sandevistanActive: false,
      actions: {}, abilityRequests: { stealth: false, sandevistan: false }, abilityUntil: {},
      sandevistanCooldownUntil: 0,
    };
    const spawn = this.safeSpawn(actor, seed);
    if (!spawn) throw new Error('Map has no safe spawn');
    Object.assign(actor, spawn);
    return actor;
  }

  register(socket, seed, initializing = false) {
    const id = ownerId(socket);
    if (this.players.has(id)) return this.players.get(id);
    if (!object(seed) || seed.id !== id) throw new Error('Joining actor missing');
    const actor = this.newActor(id, 'player', seed, this.rules.playerMaxHp);
    this.players.set(id, actor);
    this.entities.set(id, actor);
    if (initializing || socket.data.lastSeen == null) socket.data.lastSeen = this.now();
    actor.lastSeen = socket.data.lastSeen;
    actor.active = this.now() - actor.lastSeen <= CONSTANTS.SILENCE_MS;
    this.record(actor, this.now());
    return actor;
  }

  actorSnapshot(actor, now = this.now()) {
    const result = {
      id: actor.id, kind: actor.kind, x: actor.x, y: actor.y, r: actor.r, angle: actor.angle,
      hp: actor.hp, maxHp: actor.maxHp, rev: actor.rev, spawnVersion: actor.spawnVersion,
      deaths: actor.deaths, enemyKills: actor.enemyKills, pvpKills: actor.pvpKills,
      ack: actor.ack, weapon: actor.weapon, grace: Math.max(0, (actor.graceUntil - now) / 1000),
      lastSeen: actor.lastSeen, silenceMs: actor.kind === 'player' ? Math.max(0, now - actor.lastSeen) : 0,
      shotsFired: actor.shotsFired, rewardCount: actor.rewardCount,
      walk: actor.walk, hit: Math.max(0, (actor.hitUntil - now) / 1000),
      muzzle: Math.max(0, (actor.muzzleUntil - now) / 1000), fireAngle: actor.fireAngle ?? actor.angle,
      state: actor.state, dead: actor.hp <= 0, deadAt: actor.deadAt, expired: actor.expired, room: actor.room,
      selectedAbility: actor.selectedAbility, stealthActive: actor.stealthActive,
      sandevistanActive: actor.sandevistanActive,
    };
    for (const key of GEAR_FLAGS) result[key] = actor[key];
    if (actor.kind === 'boss') Object.assign(result, {
      boss: true, tier: actor.tier, reward: actor.reward, damageMultiplier: actor.damageMultiplier,
      fireRemaining: actor.fireRemaining || 0, clawCooldown: actor.clawCooldown || 0,
      fireCooldown: actor.fireCooldown || 0, lungeRemaining: actor.lungeRemaining || 0,
    });
    return result;
  }

  record(actor, now) {
    const history = this.history.get(actor.id) || [];
    const sample = { at: now, id: actor.id, x: actor.x, y: actor.y, r: actor.r, hp: actor.hp,
      angle: actor.angle, spawnVersion: actor.spawnVersion, active: actor.active,
      graceUntil: actor.graceUntil };
    const last = history.at(-1);
    if (last && last.at === now) history[history.length - 1] = sample;
    else if (last && now - last.at < 10 && last.spawnVersion === sample.spawnVersion && last.active === sample.active)
      history[history.length - 1] = sample;
    else history.push(sample);
    while (history.length > 2 && history[1].at < now - CONSTANTS.HISTORY_MS) history.shift();
    if (history.length > CONSTANTS.MAX_HISTORY) history.splice(0, history.length - CONSTANTS.MAX_HISTORY);
    this.history.set(actor.id, history);
  }

  touch(socket, now) {
    socket.data.lastSeen = now;
    const actor = this.players.get(ownerId(socket));
    if (!actor) return;
    actor.active = true;
    actor.lastSeen = now;
    this.record(actor, now);
  }

  weaponAllowed(actor, weapon) {
    if (typeof weapon !== 'string' || !Object.hasOwn(GUNS, weapon)) return false;
    if (actor.kind !== 'player') return ['pistol', 'rifle', 'rocket'].includes(weapon);
    return weapon === 'laser' ? this.rules.laser : weapon === 'nailgun' ? actor.hasNailgun :
      weapon === 'gatling' ? actor.hasGatling : true;
  }

  destroyCrates(crates) {
    for (const crate of crates) if (crate.hp > 0 && this.destroyedCrates.size < 4096)
      this.destroyedCrates.add(`${crate.x},${crate.y},${crate.w},${crate.h}`);
    let changed = false;
    this.map.crates = this.map.crates.map(crate => {
      if (crate.hp <= 0 || !this.destroyedCrates.has(`${crate.x},${crate.y},${crate.w},${crate.h}`)) return crate;
      changed = true;
      return Object.freeze({ ...crate, hp: 0 });
    });
    this.environmentDirty ||= changed;
  }

  updateAbilities(actor) {
    for (const ability of ['stealth', 'sandevistan']) {
      if (actor[`${ability}Active`] && this.time >= actor.abilityUntil[ability]) {
        actor[`${ability}Active`] = false;
        if (ability === 'sandevistan') actor.sandevistanCooldownUntil = this.time + 8;
      }
    }
  }

  acceptAbilities(actor, input) {
    this.updateAbilities(actor);
    const actions = object(input.actions) ? input.actions : {};
    const changed = {};
    for (const key of ['reload', 'ability', 'switchAbility']) {
      if (!Number.isSafeInteger(actions[key]) || actions[key] < 0 || actions[key] <= (actor.actions[key] || 0)) continue;
      actor.actions[key] = actions[key]; changed[key] = true;
    }
    const owned = ['stealth', 'sandevistan'].filter(key => actor[key === 'stealth' ? 'hasStealth' : 'hasSandevistan']);
    if (owned.includes(input.selectedAbility)) actor.selectedAbility = input.selectedAbility;
    else if (changed.switchAbility && owned.length) {
      actor.selectedAbility = owned[(owned.indexOf(actor.selectedAbility) + 1) % owned.length];
      actor.stealthActive = false; actor.sandevistanActive = false;
    } else if (!owned.includes(actor.selectedAbility)) actor.selectedAbility = owned.at(-1) || null;
    if (actor.hp <= 0 || !this.started || this.paused || this.ended) return;
    for (const ability of ['stealth', 'sandevistan']) {
      const field = `${ability}Active`;
      const requested = typeof input[field] === 'boolean' ? input[field] :
        changed.ability && actor.selectedAbility === ability ? !actor[field] : actor[field];
      const rising = requested && (!actor.abilityRequests[ability] || changed.ability);
      actor.abilityRequests[ability] = requested;
      if (!requested) { actor[field] = false; continue; }
      if (!rising || actor[field] || !owned.includes(ability) ||
        ability === 'sandevistan' && this.time < actor.sandevistanCooldownUntil) continue;
      actor[field] = true;
      actor[`${ability === 'stealth' ? 'sandevistan' : 'stealth'}Active`] = false;
      actor.selectedAbility = ability;
      actor.abilityUntil[ability] = this.rules.mode === 'infinite' ? Infinity :
        this.time + (ability === 'stealth' ? this.rules.stealthDuration : 15);
    }
  }

  acceptInput(socket, message) {
    const actor = this.players.get(ownerId(socket)), input = message.input, now = this.now();
    if (message.round !== this.round || !actor || !object(input) ||
      input.actorId !== undefined && input.actorId !== actor.id ||
      input.id !== undefined && input.id !== actor.id ||
      ![input.x, input.y, input.angle].every(Number.isFinite) || Math.abs(input.angle) > 10000 ||
      !Number.isSafeInteger(input.seq) || input.seq <= actor.ack || input.spawnVersion !== actor.spawnVersion ||
      !this.weaponAllowed(actor, input.weapon)) return null;
    actor.ack = input.seq;
    this.acceptAbilities(actor, input);
    const elapsed = clamp((now - actor.lastMoveAt) / 1000, 0, 0.25);
    actor.lastMoveAt = now;
    const dash = input.dash === true && !(this.rules.mode === 'challenge' && this.rules.dashDuration <= 0);
    const speed = actor.stealthActive ? 480 : dash ? 360 : 120;
    actor.moveCredit = Math.min(130 + speed * 0.25, actor.moveCredit + speed * elapsed);
    const distance = Math.hypot(input.x - actor.x, input.y - actor.y);
    if (!this.inBounds(input.x, input.y, actor.r) || distance > actor.moveCredit + 0.5) return null;
    actor.angle = angleDelta(input.angle, 0);
    actor.weapon = input.weapon;
    if (actor.hp > 0 && this.started && !this.paused && !this.ended) {
      const x = actor.x, y = actor.y, steps = Math.max(1, Math.ceil(distance / 4));
      for (let i = 1; i <= steps; i++) {
        const nx = x + (input.x - x) * i / steps, ny = y + (input.y - y) * i / steps;
        if (this.blocked(nx, ny, actor.r, dash)) break;
        if (dash) this.destroyCrates(this.map.crates.filter(c => c.hp > 0 && circleRect(nx, ny, actor.r, c)));
        actor.x = nx; actor.y = ny;
      }
      const moved = Math.hypot(actor.x - x, actor.y - y);
      actor.moveCredit -= moved;
      actor.walk += moved * 0.16;
    }
    this.touch(socket, now);
    const actions = {};
    if (object(input.actions)) for (const key of ['reload', 'ability', 'switchAbility'])
      if (Number.isSafeInteger(input.actions[key]) && input.actions[key] >= 0) actions[key] = input.actions[key];
    return { type: 'playerState', round: this.round, input: {
      seq: actor.ack, x: actor.x, y: actor.y, angle: actor.angle, spawnVersion: actor.spawnVersion,
      weapon: actor.weapon, dash, actions, stealthActive: actor.stealthActive, sandevistanActive: actor.sandevistanActive,
      keys: Array.isArray(input.keys) ? input.keys.filter(k => ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(k)).slice(0, 4) : [],
    } };
  }

  acceptFire(socket, message) {
    const actor = this.players.get(ownerId(socket)), now = this.now();
    if (!actor || message.actorId !== actor.id || message.round !== this.round ||
      message.spawnVersion !== actor.spawnVersion || !actor.active ||
      now - actor.lastSeen > CONSTANTS.SILENCE_MS || actor.hp <= 0 ||
      !this.started || this.paused || this.ended || !validId(message.id) || message.id.startsWith('server:') ||
      ![message.x, message.y, message.angle, message.timestamp].every(Number.isFinite) ||
      Math.abs(message.angle) > 10000 || !this.weaponAllowed(actor, message.weapon) ||
      now < actor.nextFireAt || this.seenShots.has(message.id) ||
      !this.inBounds(message.x, message.y, actor.r)) return false;
    const speed = actor.stealthActive ? 480 : 360;
    const credit = Math.min(130 + speed * 0.25, actor.moveCredit +
      speed * clamp((now - actor.lastMoveAt) / 1000, 0, 0.25));
    const distance = Math.hypot(message.x - actor.x, message.y - actor.y);
    if (distance > Math.min(130 + speed * 0.06 + 30, credit + 0.5)) return false;
    const steps = Math.max(1, Math.ceil(distance / 4)), crossedCrates = new Set();
    for (let i = 1; i <= steps; i++) {
      const x = actor.x + (message.x - actor.x) * i / steps;
      const y = actor.y + (message.y - actor.y) * i / steps;
      if (this.blocked(x, y, actor.r, true)) return false;
      for (const crate of this.map.crates) if (crate.hp > 0 && circleRect(x, y, actor.r, crate)) crossedCrates.add(crate);
    }
    this.destroyCrates(crossedCrates);
    actor.x = message.x; actor.y = message.y;
    actor.moveCredit = credit - distance;
    actor.lastMoveAt = now;
    this.record(actor, now);
    return !!this.storeShot(actor, message, clamp(finite(socket.data.rtt), 0, 4000), socket);
  }

  storeShot(actor, message, rtt = 0, except) {
    const now = this.now(), gun = GUNS[message.weapon];
    if (!gun || now < actor.nextFireAt || this.seenShots.has(message.id)) return null;
    const rewindAt = Math.max(this.createdAt, now - Math.min(CONSTANTS.HISTORY_MS, rtt / 2));
    const scene = [];
    for (const target of this.entities.values()) {
      if (!target.active) continue;
      const sampled = sampleHistory(this.history.get(target.id), rewindAt);
      if (sampled) scene.push(sampled);
    }
    const damage = actor.kind === 'player' ? gun.damage * this.rules.playerDamageMultiplier :
      message.weapon === 'rocket' ? 20 : gun.damage * this.rules.enemyDamageMultiplier;
    const draft = {
      id: message.id, shotId: message.id, ownerId: actor.id, actorId: actor.id, ownerKind: actor.kind,
      round: this.round, spawnVersion: actor.spawnVersion, weapon: message.weapon,
      x: message.x, y: message.y, angle: angleDelta(message.angle, 0),
      timestamp: finite(message.timestamp, now), receivedAt: now, rewindAt, rtt,
      range: Math.max(this.map.roomW, this.map.roomH) * 3, damage, npcClock: this.npcClock,
    };
    const shot = Object.freeze({ ...draft,
      impacts: Object.freeze(traceShot(draft, scene, this.map).map(hit => Object.freeze(hit))),
    });
    const ttl = gun.speed ? actor.kind === 'player' ?
      Math.min(CONSTANTS.SHOT_TTL_MS, draft.range / gun.speed * 1000 + CONSTANTS.HISTORY_MS) :
      Math.min(36000, draft.range / gun.speed * 5000 + CONSTANTS.HISTORY_MS) : 1000;
    this.shots.set(shot.id, shot);
    this.shotClaims.set(shot.id, { hits: new Set(), expiresAt: now + ttl });
    this.seenShots.set(shot.id, now);
    while (this.shots.size > CONSTANTS.MAX_SHOTS) this.deleteShot(this.shots.keys().next().value);
    while (this.seenShots.size > CONSTANTS.MAX_SHOTS * 4) this.seenShots.delete(this.seenShots.keys().next().value);
    actor.nextFireAt = now + gun.interval * 1000;
    actor.weapon = shot.weapon;
    actor.angle = shot.angle;
    actor.fireAngle = shot.angle;
    actor.muzzleUntil = now + 65;
    actor.stealthActive = false;
    actor.shotsFired++;
    if (shot.weapon === 'katana') {
      const slash = slashPath(shot, this.map);
      this.destroyCrates(slash.ignored);
      // The next owner sample carries the predicted blink; grant exactly its validated length.
      actor.moveCredit = Math.max(actor.moveCredit, Math.hypot(slash.x - actor.x, slash.y - actor.y) + 30);
    }
    this.emit({ type: 'fireEvent', id: shot.id, shotId: shot.id, ownerId: actor.id, actorId: actor.id,
      round: this.round, spawnVersion: actor.spawnVersion, weapon: shot.weapon,
      x: shot.x, y: shot.y, angle: shot.angle, timestamp: shot.timestamp, serverTime: now }, except);
    return shot;
  }

  deleteShot(id) { this.shots.delete(id); this.shotClaims.delete(id); }

  acceptClaim(socket, message) {
    const now = this.now(), shot = this.shots.get(message.fireId), claimant = ownerId(socket);
    if (message.round !== this.round || !shot || !validId(message.targetId) ||
      !Number.isInteger(message.pellet) || message.pellet < 0 ||
      message.pellet > (shot.weapon === 'nailgun' ? 2 : 0) ||
      (shot.ownerKind === 'player' ? shot.ownerId !== claimant : message.targetId !== claimant)) return false;
    const claims = this.shotClaims.get(shot.id), shooter = this.entities.get(shot.ownerId);
    const target = this.entities.get(message.targetId), key = `${message.pellet}:${message.targetId}`;
    if (!claims || now > claims.expiresAt || claims.hits.has(key) || !shooter || !target ||
      shooter.hp <= 0 || !shooter.active || shooter.spawnVersion !== shot.spawnVersion ||
      !target.active || target.hp <= 0 || target.graceUntil > now ||
      target.kind === 'player' && now - target.lastSeen > CONSTANTS.SILENCE_MS ||
      shooter.kind === 'player' && now - shooter.lastSeen > CONSTANTS.SILENCE_MS) return false;
    const hit = shot.impacts.find(h => h.targetId === target.id && h.pellet === message.pellet);
    if (!hit || hit.spawnVersion !== target.spawnVersion || hit.grace > 0) return false;
    if (shot.ownerKind !== 'player' && this.npcClock - shot.npcClock + 80 < hit.distance / GUNS[shot.weapon].speed * 1000)
      return false;
    claims.hits.add(key);
    this.applyDamage(target, hit.damage, shooter, shot.id, now);
    return true;
  }

  applyDamage(target, amount, shooter, fireId, now = this.now()) {
    if (!Number.isFinite(amount) || amount <= 0 || target.hp <= 0 || !target.active || target.graceUntil > now) return false;
    target.hp = Math.max(0, target.hp - amount);
    target.rev++;
    target.hitUntil = now + 120;
    const killed = target.hp <= 0;
    if (killed) {
      target.deaths++;
      target.rev++;
      target.dead = true;
      target.deadAt = this.time;
      target.state = 'dead';
      if (shooter?.kind === 'player' && shooter !== target) {
        if (target.kind === 'player') shooter.pvpKills++;
        else {
          if (target.kind === 'npc') shooter.enemyKills++;
          if (shooter.hp > 0) shooter.hp = Math.min(shooter.maxHp, shooter.hp + 3);
          if (target.kind === 'npc' && shooter.enemyKills % 10 === 0)
            this.hostNotice({ id: `red:${this.round}:${shooter.id}:${shooter.enemyKills}`,
              kind: 'red', ownerId: shooter.id, enemyKills: shooter.enemyKills });
        }
        shooter.rev++;
        this.record(shooter, now);
      }
      if (target.kind === 'player') {
        target.spawnVersion++;
        target.stealthActive = false;
        target.sandevistanActive = false;
        target.abilityRequests = { stealth: false, sandevistan: false };
        target.burn = null;
        target.nextFireAt = now;
        if (this.rules.mode !== 'challenge' || target.deaths <= this.rules.challengeRespawns)
          this.respawn(target, now);
      } else if (target.kind === 'boss') {
        target.fireRemaining = 0;
        this.nextMonsterAt = this.time + 60;
        this.hostNotice({ id: `chip:${this.round}:${target.tier}`, kind: 'chip', x: target.x, y: target.y,
          ability: target.tier % 2 ? 'stealth' : 'sandevistan', ownerId: shooter?.id || null });
      }
    } else if (target.kind === 'npc' && target.state === 'patrol') {
      target.state = 'alert'; target.alert = 0.7; target.lost = 0;
    }
    this.record(target, now);
    this.emit(this.packet('killConfirm', {
      fireId, targetId: target.id, shooterId: shooter?.id || null, damage: amount, killed,
      target: this.actorSnapshot(target, now), shooter: shooter ? this.actorSnapshot(shooter, now) : null,
    }));
    return true;
  }

  respawn(actor, now) {
    const point = this.safeSpawn(actor);
    actor.waitingRespawn = !point;
    actor.lastSpawnAttempt = now;
    if (!point) return;
    Object.assign(actor, point);
    actor.hp = actor.maxHp;
    actor.rev++;
    actor.dead = false;
    actor.deadAt = null;
    actor.expired = false;
    actor.state = 'patrol';
    actor.graceUntil = now + CONSTANTS.GRACE_MS;
    actor.lastMoveAt = now;
    actor.moveCredit = 130;
    this.record(actor, now);
  }

  ingestGear(raw, now) {
    for (const seed of [...(Array.isArray(raw.players) ? raw.players.slice(0, 8) : []), raw.player]) {
      if (!object(seed)) continue;
      const actor = this.players.get(seed.id);
      if (!actor || seed.spawnVersion !== actor.spawnVersion) continue;
      // Pickups are durable within a round; old host snapshots cannot revoke owner gear.
      for (const key of GEAR_FLAGS) if (seed[key] === true) actor[key] = true;
      // Only owner input can select/activate abilities. Host actor data never changes vitals or liveness.
      this.record(actor, now);
    }
  }

  ingestDrops(raw, now) {
    if (!Array.isArray(raw)) return;
    for (const drop of raw.slice(0, 256)) {
      if (!object(drop) || !validId(drop.id) || ![drop.x, drop.y].every(Number.isFinite) ||
        !this.inBounds(drop.x, drop.y, 0) || !['red', 'special', 'gatling', 'nailgun'].includes(drop.kind)) continue;
      let stored = this.drops.get(drop.id);
      if (!stored) {
        if (drop.claimed || !drop.spawned || this.drops.size >= CONSTANTS.MAX_DROPS ||
          drop.ownerId != null && !this.players.has(drop.ownerId)) continue;
        stored = { id: drop.id, x: drop.x, y: drop.y, kind: drop.kind, ownerId: drop.ownerId || null,
          landed: drop.landed === true, claimed: false, registeredAt: now };
        this.drops.set(drop.id, stored);
        continue;
      }
      if (stored.claimed || stored.x !== drop.x || stored.y !== drop.y || stored.kind !== drop.kind) continue;
      stored.landed ||= drop.landed === true;
      if (!drop.claimed || !stored.landed || now <= stored.registeredAt) continue;
      const claimant = drop.claimedById || drop.claimedBy || drop.ownerId;
      const actor = this.players.get(claimant);
      if (!actor || !actor.active || actor.hp <= 0 || now - actor.lastSeen > CONSTANTS.SILENCE_MS ||
        stored.ownerId && stored.ownerId !== claimant || Math.hypot(actor.x - stored.x, actor.y - stored.y) > 36) continue;
      stored.claimed = true;
      stored.claimedBy = actor.id;
      actor.hp = actor.maxHp;
      actor.rewardCount++;
      actor.rev++;
      this.record(actor, now);
    }
  }

  worldSnapshot(message) {
    const raw = message.snapshot, now = this.now();
    if (!object(raw) || raw.round !== this.round || !Number.isSafeInteger(message.seq) || message.seq < this.worldSeq) return null;
    if (message.seq > this.worldSeq) {
      try {
        const updates = {};
        for (const [key, kind, max] of [['walls', 'wall', 4096], ['crates', 'crate', 2048], ['pillars', 'pillar', 1024]])
          if (Object.hasOwn(raw, key)) updates[key] = sanitizeRects(raw[key], kind, this.map, max);
        Object.assign(this.map, updates);
        this.destroyCrates([]);
      } catch { return null; }
      this.worldSeq = message.seq;
      if (typeof raw.started === 'boolean') this.started = raw.started;
      if (typeof raw.paused === 'boolean') this.paused = raw.paused;
      if (typeof raw.ended === 'boolean') this.ended = raw.ended;
      this.ingestGear(raw, now);
      this.ingestDrops(raw.airdrops, now);
    }
    const snapshot = sanitizeWorldSnapshot(raw);
    snapshot.round = this.round;
    snapshot.rules = this.rules;
    snapshot.playerMaxHp = this.rules.playerMaxHp;
    snapshot.nextMonsterAt = this.nextMonsterAt;
    snapshot.monsterTier = this.monsterTier;
    for (const key of ['walls', 'crates', 'pillars']) if (Object.hasOwn(raw, key)) snapshot[key] = this.map[key];
    return { type: 'playerState', seq: message.seq, round: this.round, snapshot };
  }

  patchedMap(message, localId) {
    const now = this.now();
    const players = [...this.players.values()].filter(a => a.active).map(a => this.actorSnapshot(a, now));
    const enemies = [...this.enemies.values()].map(a => this.actorSnapshot(a, now));
    return { type: 'map', roomId: this.room.code, localId,
      map: { ...this.map, enemies },
      snapshot: { ...sanitizeWorldSnapshot(message.snapshot), rules: this.rules, round: this.round,
        started: this.started, paused: this.paused, ended: this.ended, time: this.time,
        playerMaxHp: this.rules.playerMaxHp, nextMonsterAt: this.nextMonsterAt, monsterTier: this.monsterTier,
        walls: this.map.walls, crates: this.map.crates, pillars: this.map.pillars,
        player: players.find(p => p.id === this.room.code) || null, players, enemies,
        monster: this.monster ? this.actorSnapshot(this.monster, now) : null } };
  }

  nearestOpponent(actor, now) {
    let nearest = null, distance = Infinity;
    for (const other of this.players.values()) if (other.active && other.hp > 0 &&
      now - other.lastSeen <= CONSTANTS.SILENCE_MS && !other.stealthActive && other.graceUntil <= now) {
      const d = Math.hypot(actor.x - other.x, actor.y - other.y);
      if (d < distance) { nearest = other; distance = d; }
    }
    return nearest;
  }

  moveNpc(actor, x, y, distance) {
    const length = Math.hypot(x - actor.x, y - actor.y);
    if (!length) return false;
    const move = Math.min(distance, length), sx = actor.x, sy = actor.y;
    const steps = Math.max(1, Math.ceil(move / 4));
    for (let i = 1; i <= steps; i++) {
      const nx = sx + (x - sx) / length * move * i / steps;
      const ny = sy + (y - sy) / length * move * i / steps;
      if (this.blocked(nx, ny, actor.r)) break;
      actor.x = nx; actor.y = ny;
    }
    actor.walk += Math.hypot(actor.x - sx, actor.y - sy) * 0.2;
    return actor.x !== sx || actor.y !== sy;
  }

  updateEnemy(actor, dt, now) {
    if (actor.hp <= 0) return;
    const target = this.nearestOpponent(actor, now);
    if (!target) return;
    actor.cooldown = Math.max(0, actor.cooldown - dt);
    const distance = Math.hypot(actor.x - target.x, actor.y - target.y);
    const visible = distance < 430 && lineClear(this.map, actor.x, actor.y, target.x, target.y);
    if (actor.state === 'patrol' && visible) { actor.state = 'alert'; actor.alert = 0.7; actor.lost = 0; }
    if (actor.state !== 'patrol') {
      actor.angle = Math.atan2(target.y - actor.y, target.x - actor.x);
      actor.lost = visible ? 0 : actor.lost + dt;
      if (actor.lost > 1.25) { actor.state = 'patrol'; actor.wait = 0.35; return; }
      if (actor.state === 'alert') { actor.alert -= dt; if (actor.alert <= 0) actor.state = 'combat'; }
      if (actor.state === 'combat' && visible) {
        if (actor.cooldown <= 0) {
          this.storeShot(actor, { id: `server:${this.round}:${++this.serverFireSeq}`,
            weapon: actor.weapon, x: actor.x, y: actor.y,
            angle: actor.angle + (this.random() * 2 - 1) * 0.018, timestamp: now });
          actor.cooldown = actor.weapon === 'rocket' ? 10 : actor.weapon === 'rifle' ? 0.075 : 0.58 + this.random() * 0.24;
        }
        const side = Math.sin(this.time * 2 + actor.room) > 0 ? 1 : -1;
        this.moveNpc(actor, actor.x + Math.cos(actor.angle + Math.PI / 2) * side * 100,
          actor.y + Math.sin(actor.angle + Math.PI / 2) * side * 100, 24 * dt);
      }
    } else {
      actor.wait -= dt;
      if (actor.wait <= 0 && !this.moveNpc(actor, actor.x + Math.cos(actor.angle) * 100,
        actor.y + Math.sin(actor.angle) * 100, 38 * dt)) {
        actor.angle += Math.PI * (0.5 + this.random()); actor.wait = 0.3;
      }
    }
    this.record(actor, now);
  }

  spawnMonster(now) {
    if (this.rules.combat !== 'pvevp' || this.map.mapType === 'desert' || this.monster ||
      ![...this.players.values()].some(a => a.active && a.hp > 0)) return false;
    const tier = this.monsterTier;
    let actor;
    try {
      actor = this.newActor(`monster-${tier}`, 'boss', {}, Math.min(10000000, tier === 0 ? 400 : 2000 * 1.5 ** (tier - 1)));
    } catch { return false; }
    Object.assign(actor, { boss: true, tier, damageMultiplier: Math.min(100000, tier === 0 ? 1 : 5 * 1.5 ** (tier - 1)),
      reward: tier % 2 ? '\u9690\u8eab\u82af\u7247' : '\u65af\u5b89\u5a01\u65af\u5766\u82af\u7247',
      clawCooldown: 0, fireCooldown: 0, fireRemaining: 0, lungeRemaining: 0 });
    this.monster = actor;
    this.monsterTier++;
    this.nextMonsterAt = this.time + 60;
    this.entities.set(actor.id, actor);
    this.record(actor, now);
    return true;
  }

  updateMonster(dt, now) {
    const actor = this.monster;
    if (!actor || actor.hp <= 0) return;
    const target = this.nearestOpponent(actor, now);
    actor.clawCooldown = Math.max(0, actor.clawCooldown - dt);
    actor.fireCooldown = Math.max(0, actor.fireCooldown - dt);
    actor.fireRemaining = Math.max(0, actor.fireRemaining - dt);
    if (!target) return;
    const distance = Math.hypot(target.x - actor.x, target.y - actor.y);
    if (distance > Math.max(this.map.roomW, this.map.roomH) * 4) return;
    actor.angle = Math.atan2(target.y - actor.y, target.x - actor.x);
    if (actor.fireCooldown <= 0 && distance <= 260 && lineClear(this.map, actor.x, actor.y, target.x, target.y)) {
      actor.fireRemaining = 2; actor.fireCooldown = 12;
      target.burn = { until: now + 3000, next: now, amount: 2 * actor.damageMultiplier,
        shooterId: actor.id, spawnVersion: target.spawnVersion };
    }
    if (actor.clawCooldown <= 0 && distance <= 104 && lineClear(this.map, actor.x, actor.y, target.x, target.y)) {
      this.applyDamage(target, 5 * actor.damageMultiplier, actor, `server:claw:${++this.serverFireSeq}`, now);
      actor.clawCooldown = 3; actor.lungeRemaining = 0.24;
    }
    this.moveNpc(actor, target.x, target.y, 192 * (actor.lungeRemaining > 0 ? 3 : 1) * dt);
    actor.lungeRemaining = Math.max(0, actor.lungeRemaining - dt);
    this.record(actor, now);
  }

  tick(now = this.now()) {
    const elapsed = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    const running = this.started && !this.paused && !this.ended;
    if (running) this.time += elapsed / 1000;
    for (const actor of this.players.values()) {
      const socket = this.socketFor(actor.id);
      if (!socket || socket.connected === false || now - actor.lastSeen > CONSTANTS.SILENCE_MS) {
        if (actor.active) { actor.active = false; this.record(actor, now); }
      }
      if (running && actor.active && actor.waitingRespawn && now - actor.lastSpawnAttempt >= 500) this.respawn(actor, now);
      if (running) this.updateAbilities(actor);
      const burn = actor.burn;
      if (running && actor.active && burn && burn.spawnVersion === actor.spawnVersion && now >= burn.next && now < burn.until) {
        burn.next = now + 1000;
        this.applyDamage(actor, burn.amount, this.entities.get(burn.shooterId), `server:burn:${++this.serverFireSeq}`, now);
      }
      if (burn && now >= burn.until) actor.burn = null;
    }
    this.timeScale = [...this.players.values()].some(a => a.active && a.hp > 0 && a.sandevistanActive) ? 0.2 : 1;
    if (running) this.npcClock += elapsed * this.timeScale;
    if (now - this.lastNpcs >= CONSTANTS.NPC_INTERVAL_MS) {
      const dt = Math.min(0.25, (now - this.lastNpcs) / 1000) * this.timeScale;
      this.lastNpcs = now;
      if (running && this.npcsEnabled) {
        for (const actor of this.enemies.values()) this.updateEnemy(actor, dt, now);
        if (!this.monster && this.time >= this.nextMonsterAt) this.spawnMonster(now);
        this.updateMonster(dt, now);
      }
      for (const actor of this.enemies.values()) {
        if (actor.hp <= 0 && this.time - actor.deadAt > 5) actor.expired = true;
        this.record(actor, now);
      }
      if (this.monster?.hp <= 0 && this.time - this.monster.deadAt > 5) {
        this.entities.delete(this.monster.id); this.history.delete(this.monster.id); this.monster = null;
      }
      this.emit(this.packet('npcUpdate', { enemies: [...this.enemies.values()].map(a => this.actorSnapshot(a, now)),
        monster: this.monster ? this.actorSnapshot(this.monster, now) : null,
        nextMonsterAt: this.nextMonsterAt, monsterTier: this.monsterTier, time: this.time, timeScale: this.timeScale,
        ...(this.environmentDirty ? { crates: this.map.crates } : {}) }));
      this.environmentDirty = false;
    }
    if (now - this.lastPlayers >= CONSTANTS.PLAYER_INTERVAL_MS) {
      this.lastPlayers = now;
      for (const actor of this.players.values()) this.record(actor, now);
      this.emit(this.packet('playerState', {
        players: [...this.players.values()].filter(a => a.active).map(a => this.actorSnapshot(a, now)),
      }));
    }
    for (const [id, claim] of this.shotClaims) if (now > claim.expiresAt) this.deleteShot(id);
  }
}

function createRelay(options = {}) {
  const now = options.now || Date.now;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
    if (!['/', '/neon-wick-room36.html'].includes(req.url?.split('?')[0])) {
      res.writeHead(404); res.end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    const stream = fs.createReadStream(path.join(__dirname, 'neon-wick-room36.html'));
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500); res.end('Page unavailable'); });
    stream.pipe(res);
  });
  const origins = process.env.ALLOWED_ORIGINS?.split(',').map(s => s.trim());
  const io = new Server(server, {
    cors: { origin: origins || '*' },
    allowRequest: (req, done) => done(null, !origins || !req.headers.origin || origins.includes(req.headers.origin)),
    maxHttpBufferSize: 1024 * 1024,
  });
  const rooms = new Map();
  function challenge(socket, time) {
    if (socket.connected === false) return;
    if (socket.data.ping && time - socket.data.ping.at <= 4000) return;
    const nonce = randomBytes(12).toString('hex');
    socket.data.ping = { nonce, at: time };
    socket.data.lastChallenge = time;
    socket.emit('game-message', { from: 'server', message: { type: 'ping', nonce, serverTime: time } });
  }
  function tick() {
    const time = now();
    for (const room of rooms.values()) {
      room.authority?.tick(time);
      for (const socket of members(room)) if (time - (socket.data.lastChallenge ?? -Infinity) >= CONSTANTS.PING_INTERVAL_MS)
        challenge(socket, time);
    }
  }
  const timer = options.autoTick === false ? null : setInterval(tick, 20);
  timer?.unref();
  const stop = () => { if (timer) clearInterval(timer); };
  server.on('close', stop);
  io.on('connection', socket => {
    const { roomCode } = socket.handshake.auth;
    if (roomCode) {
      if (!/^nw-[a-f0-9]{16}$/.test(roomCode) || rooms.has(roomCode) || rooms.size >= 500) {
        socket.emit('relay-error', { type: 'room-unavailable', message: '\u623f\u95f4\u7801\u4e0d\u53ef\u7528\uff0c\u8bf7\u91cd\u65b0\u521b\u5efa' });
        return;
      }
      rooms.set(roomCode, { code: roomCode, host: socket, guests: new Map(), authority: null });
      socket.data.host = true; socket.data.room = roomCode;
    }
    socket.data.lastSeen = now();
    socket.emit('registered', { id: roomCode || socket.id });
    challenge(socket, now());
    socket.on('join-room', code => {
      if (socket.data.room || !takeRate(socket.data, 'channel', now())) return;
      const room = typeof code === 'string' && rooms.get(code);
      if (!room || room.guests.size >= 7) {
        socket.emit('relay-error', { type: room ? 'room-full' : 'room-not-found',
          message: room ? '\u623f\u95f4\u5df2\u6ee1' : '\u623f\u95f4\u4e0d\u5b58\u5728\u6216\u623f\u4e3b\u5df2\u9000\u51fa' });
        return;
      }
      socket.data.room = code; socket.data.lastSeen = now(); room.guests.set(socket.id, socket);
      room.host.emit('channel-open', socket.id);
      socket.emit('channel-open', code);
    });
    socket.on('relay', packet => {
      if (!object(packet) || !object(packet.message)) return;
      const message = packet.message, type = message.type, time = now();
      if (typeof type !== 'string') return;
      if (type === 'ping') {
        if (!takeRate(socket.data, 'ping', time)) return;
        const ping = socket.data.ping;
        if (!ping || message.nonce !== ping.nonce || time < ping.at || time - ping.at > 4000) return;
        const sample = time - ping.at;
        socket.data.ping = null;
        const samples = socket.data.rttSamples || (socket.data.rttSamples = []);
        samples.push(sample); if (samples.length > 8) samples.shift();
        // A delayed echo cannot inflate a previously observed low-latency connection.
        socket.data.rtt = Math.min(...samples);
        socket.emit('game-message', { from: 'server',
          message: { type: 'ping', rtt: socket.data.rtt, serverTime: time, nonce: ping.nonce } });
        return;
      }
      const room = rooms.get(socket.data.room);
      if (!room) return;
      const rateType = type === 'playerState' ? (message.input ? 'input' : 'world') : type;
      if (!takeRate(socket.data, rateType, time)) return;
      const from = ownerId(socket), authority = room.authority;
      const target = socket.data.host ? room.guests.get(packet.target) : packet.target === socket.data.room ? room.host : null;
      if (type === 'heartbeat') {
        if (message.round !== undefined && authority && message.round !== authority.round) return;
        socket.data.lastSeen = time;
        authority?.touch(socket, time);
        const heartbeat = { type, timestamp: finite(message.timestamp), serverTime: time };
        for (const recipient of members(room)) recipient.emit('game-message', { from, message: heartbeat });
        return;
      }
      if (type === 'fireEvent') { authority?.acceptFire(socket, message); return; }
      if (type === 'hitClaim') { authority?.acceptClaim(socket, message); return; }
      if (type === 'map' && socket.data.host) {
        const round = message.snapshot?.round;
        if (!object(message.snapshot) || !object(message.map) || !Number.isSafeInteger(round) || round < 0 ||
          message.round !== undefined && message.round !== round) return;
        try {
          if (packet.target != null) {
            if (!target || message.localId !== target.id) return;
            if (!authority && round === 0 && message.snapshot.started === false)
              room.authority = new RoundAuthority(room, message.map, message.snapshot, { ...options, now });
            if (!room.authority || round !== room.authority.round) return;
            const seed = Array.isArray(message.snapshot.players) ? message.snapshot.players.find(p => p?.id === target.id) : null;
            room.authority.register(target, seed);
          } else if (!authority || round > authority.round) {
            room.authority = new RoundAuthority(room, message.map, message.snapshot, { ...options, now });
          } else if (round !== authority.round) return;
          if (target) target.emit('relay', { from, message: room.authority.patchedMap(message, target.id) });
        } catch (error) {
          options.onReject?.({ type, from, reason: error.message });
        }
        return;
      }
      if (type === 'playerState') {
        if (!authority || message.input && message.snapshot) return;
        if (message.input) {
          const accepted = authority.acceptInput(socket, message);
          if (accepted && !socket.data.host) room.host.emit('relay', { from, message: accepted });
        } else if (socket.data.host) {
          const accepted = authority.worldSnapshot(message);
          if (accepted) {
            const recipients = packet.target == null ? [...room.guests.values()] : target ? [target] : [];
            for (const recipient of recipients) recipient.emit('relay', { from, message: accepted });
          }
        }
        return;
      }
      if (!target || !(socket.data.host ? ['reject'] : ['join', 'leave']).includes(type)) return;
      target.emit('relay', { from, message });
    });
    socket.on('close-channel', target => {
      if (!takeRate(socket.data, 'channel', now())) return;
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
        room.guests.delete(socket.id);
        const actor = room.authority?.players.get(socket.id);
        if (actor) {
          room.authority.players.delete(socket.id);
          room.authority.entities.delete(socket.id);
          room.authority.history.delete(socket.id);
        }
        room.host.emit('channel-close', socket.id);
      }
    });
    options.onConnection?.(socket);
  });
  return { server, io, rooms, tick, challenge,
    close: () => new Promise(resolve => { stop(); io.close(resolve); }) };
}

function start() {
  const relay = createRelay();
  relay.server.listen(Number(process.env.PORT) || 3000, '0.0.0.0',
    () => console.log(`Neon Wick: http://localhost:${relay.server.address().port}`));
  return relay;
}

if (require.main === module) start();
module.exports = { createRelay, start, RoundAuthority, GUNS, CONSTANTS, RATE_LIMITS,
  rayRect, rayCircle, circleRect, traceShot, sampleHistory, takeRate, sanitizeWorldSnapshot };
