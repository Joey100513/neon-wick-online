const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { createRelay } = require('../server.js');
async function run() {
  const relay = createRelay();
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${relay.server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const contexts = await Promise.all([browser.newContext({ viewport: { width: 1440, height: 1000 } }),
      browser.newContext({ viewport: { width: 1100, height: 850 } })]);
    for (const context of contexts) await context.addInitScript(() => { globalThis.__collectGame = game => { globalThis.game = game; }; });
    const [host, guest] = await Promise.all(contexts.map(c => c.newPage()));
    for (const page of [host, guest]) {
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(address);
      await page.evaluate(url => { document.getElementById('relayAddress').value = url; game.state.muted = true; }, address);
    }
    await host.evaluate(() => { game.roomRules = { ...game.roomRules, mapType: 'desert', combat: 'pvp', playerMaxHp: 80 }; });
    await host.locator('#createRoom').click();
    await host.waitForFunction(() => !!game.network.roomId);
    const code = await host.evaluate(() => game.network.roomId);
    await guest.locator('#joinRoom').click();
    await guest.locator('#roomIdInput').fill(code);
    await guest.locator('#roomAction').click();
    await guest.waitForFunction(() => game.network.ready);
    await host.locator('#roomAction').click();
    await guest.waitForFunction(() => game.network.gameStarted && !game.state.menu);
    await host.waitForFunction(() => game.network.lastStateSeq > 2);
    await guest.waitForFunction(() => game.network.lastStateSeq > 2);
    await guest.locator('canvas').first().click({ position: { x: 500, y: 300 } });
    for (let i = 0; i < 12; i++) {
      await guest.keyboard.down(i % 2 ? 'a' : 'd');
      await guest.waitForTimeout(300);
      await guest.keyboard.up(i % 2 ? 'a' : 'd');
      await guest.keyboard.press('Space');
      const info = await guest.evaluate(() => ({
        x: game.player.x, y: game.player.y, cameraX: game.camera.x, cameraY: game.camera.y,
        hp: game.player.hp, ready: game.network.ready, inBounds: game.validPosition(game.player),
        ownId: game.player.id, localId: game.network.localId,
      }));
      assert.ok(info.ready && info.inBounds && Number.isFinite(info.cameraX) && Number.isFinite(info.cameraY), JSON.stringify(info));
      assert.equal(info.ownId, info.localId);
    }
    await guest.keyboard.press('q');
    await guest.waitForTimeout(600);
    assert.equal(await guest.evaluate(() => game.player.weapon), 'katana');
    await guest.mouse.click(500, 350);
    await guest.waitForTimeout(500);
    const authority = relay.rooms.get(code).authority;
    const hostActor = authority.players.get(code);
    const guestId = await guest.evaluate(() => game.network.localId);
    const guestActor = authority.players.get(guestId);
    for (const page of [host, guest]) await page.evaluate(() => {
      game.walls.length = 0; game.pillars.length = 0; game.crates.length = 0;
      game.pointer.left = false; game.keys.clear();
    });
    authority.map.walls = []; authority.map.pillars = []; authority.map.crates = [];
    for (const [actor, x] of [[hostActor, 200], [guestActor, 350]]) {
      actor.x = x; actor.y = 200; actor.graceUntil = 0; actor.hp = 80;
      actor.spawnVersion++; actor.rev++; actor.nextFireAt = 0;
      authority.record(actor, Date.now());
    }
    await guest.waitForFunction(version => game.player.spawnVersion === version, guestActor.spawnVersion);
    await host.waitForFunction(version => game.player.spawnVersion === version, hostActor.spawnVersion);
    await guest.waitForTimeout(300);
    const immediate = await guest.evaluate(() => {
      game.player.weapon = 'pistol'; game.player.draw = 0; game.player.cooldown = 0;
      const victim = game.remotePlayers.get(game.network.roomId), hp = victim.hp;
      const result = game.shoot(game.player, 'pistol', Math.PI);
      return { result, before: hp, after: victim.hp, bullets: game.bullets.length };
    });
    assert.ok(immediate.result && immediate.bullets > 0);
    assert.equal(immediate.before, immediate.after, 'Local shot does not directly subtract health');
    await host.waitForFunction(() => game.player.hp === 79, undefined, { timeout: 5000 });
    assert.equal(hostActor.hp, 79);
    await guest.waitForFunction(() => game.remotePlayers.get(game.network.roomId).hp === 79);
    // Use a lethal, server-validated katana claim to exercise respawn/camera convergence.
    guestActor.x = 260; guestActor.y = 200; guestActor.spawnVersion++; guestActor.rev++;
    guestActor.nextFireAt = 0; authority.record(guestActor, Date.now());
    const previousLife = hostActor.spawnVersion;
    await guest.waitForFunction(version => game.player.spawnVersion === version, guestActor.spawnVersion);
    await guest.waitForTimeout(300);
    await guest.evaluate(() => {
      game.player.weapon = 'katana'; game.player.angle = Math.PI;
      game.player.draw = 0; game.player.cooldown = 0; game.player.swing = null;
      game.startSlash();
    });
    await host.waitForFunction(version => game.player.spawnVersion > version && game.player.hp === 80, previousLife);
    assert.equal(hostActor.deaths, 1);
    assert.ok(await host.evaluate(() => game.validPosition(game.player) && Number.isFinite(game.camera.x)));
    for (const page of [host, guest]) {
      assert.ok(await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        const p = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const colors = new Set();
        for (let i = 0; i < p.length; i += 400) colors.add(`${p[i]},${p[i + 1]},${p[i + 2]}`);
        return colors.size > 20;
      }), 'Canvas is nonblank');
    }
    const directory = process.env.QA_OUTPUT || '/private/tmp/neon-wick-qa';
    fs.mkdirSync(directory, { recursive: true });
    await guest.screenshot({ path: directory + '/multiplayer-desktop.png' });
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.screenshot({ path: directory + '/multiplayer-mobile.png' });
    assert.ok(await guest.evaluate(() => document.getElementById('closeSettings').closest('#settingsPanel')));
    await host.evaluate(() => {
      game.roomRules = { ...game.roomRules, combat: 'pvevp', mapType: 'rooms', enemyCount: 1 };
      game.restart();
    });
    const nextRound = await host.evaluate(() => game.network.round);
    await guest.waitForFunction(round => game.network.round === round && game.network.ready, nextRound);
    const pve = relay.rooms.get(code).authority;
    for (const page of [host, guest]) await page.evaluate(() => {
      game.walls.length = 0; game.pillars.length = 0; game.crates.length = 0;
      game.pointer.left = false; game.keys.clear();
    });
    pve.map.walls = []; pve.map.pillars = []; pve.map.crates = [];
    for (const [actor, x] of [[pve.players.get(code), 200], [pve.players.get(guestId), 1000]]) {
      actor.x = x; actor.y = 200; actor.spawnVersion++; actor.rev++; actor.graceUntil = 0;
      pve.record(actor, Date.now());
    }
    const npc = [...pve.enemies.values()][0];
    npc.x = 350; npc.y = 200; npc.weapon = 'pistol'; npc.state = 'combat';
    npc.cooldown = 0; npc.nextFireAt = 0; pve.record(npc, Date.now());
    await host.waitForFunction(() => game.player.hp < 80, undefined, { timeout: 7000 });
    assert.ok(pve.players.get(code).hp < 80, 'NPC fire and victim claims cause server-authoritative damage');
    await guest.waitForFunction(() => game.enemies.length === 1);
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: two browsers; lobby join/start; movement/dash; local shots; PVP damage; lethal katana/respawn/camera; PVE round restart/NPC damage; nonblank Canvas; desktop/mobile screenshots.');
  } finally {
    await browser.close();
    await new Promise(resolve => relay.io.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
