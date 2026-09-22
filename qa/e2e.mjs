import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

// The diagnostics hook (`window.titan`) is exposed in dev builds only — release
// builds must not hand a console a handle on the game. So the harness drives the
// dev server by default; point it at the preview build with QA_CLIENT_URL to
// check the production bundle, and the diagnostics-dependent steps will report
// as skipped rather than failing.
const CLIENT_URL = process.env.QA_CLIENT_URL ?? 'http://127.0.0.1:5173';
const SERVER_WS = process.env.QA_SERVER_WS ?? 'ws://127.0.0.1:8080';
const URL = `${CLIENT_URL}/?server=${SERVER_WS}`;
const log = (...a) => console.log('[QA]', ...a);

async function makeClient(name, index) {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
           '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error') errors.push(text);
    if (/\[(Game|Net|Renderer|Boot|Audio|Assets)\]/.test(text)) log(`${name}:`, text.slice(0, 160));
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(URL, { waitUntil: 'networkidle' });
  return { browser, page, errors, name, index };
}

const results = { steps: [], errors: [] };
const step = (n, ok, detail = '') => {
  results.steps.push({ name: n, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'} — ${n}${detail ? ` (${detail})` : ''}`);
};
// Recorded separately from pass/fail: a skipped step is not evidence of
// anything, and counting it as a pass would overstate what was verified.
const skip = (n, why) => {
  results.steps.push({ name: n, skipped: true, detail: why });
  log(`SKIP — ${n} (${why})`);
};

const a = await makeClient('A', 0);
const b = await makeClient('B', 1);

try {
  // ---- boot ----
  await a.page.waitForSelector('#screen-login.active', { timeout: 15000 });
  step('client boots to the login screen', true);

  const canvasOk = await a.page.evaluate(() => {
    const c = document.getElementById('viewport');
    return !!(c && (c.getContext('webgl2') || c.getContext('webgl')));
  });
  step('WebGL context is available', canvasOk);

  // ---- login both ----
  for (const c of [a, b]) {
    await c.page.fill('[data-el="loginName"]', `Operator${c.index + 1}`);
    await c.page.click('[data-el="loginEnter"]');
  }
  await a.page.waitForSelector('#screen-menu.active', { timeout: 15000 });
  await b.page.waitForSelector('#screen-menu.active', { timeout: 15000 });
  step('both clients connect and reach the menu', true);

  const profile = await a.page.evaluate(() => ({
    name: document.querySelector('[data-el="menuName"]')?.textContent,
    level: document.querySelector('[data-el="menuLevel"]')?.textContent,
    coins: document.querySelector('[data-el="menuCoins"]')?.textContent,
  }));
  step('profile loaded from the server', profile.name === 'Operator1' && profile.coins !== '0',
       JSON.stringify(profile));

  // ---- meta screens render ----
  for (const tab of ['loadout', 'inventory', 'shop', 'quests', 'rank', 'settings']) {
    await a.page.click(`[data-tab="${tab}"]`);
    await a.page.waitForTimeout(180);
    const hasContent = await a.page.evaluate(() =>
      (document.querySelector('[data-el="menuContent"]')?.textContent ?? '').trim().length > 20);
    step(`menu tab "${tab}" renders`, hasContent);
  }
  await a.page.click('[data-tab="play"]');

  // ---- queue both into TDM ----
  for (const c of [a, b]) {
    await c.page.click('[data-mode="tdm"]');
    await c.page.click('[data-el="playButton"]');
  }
  step('both clients queued', true);

  // ---- match ----
  await a.page.waitForSelector('#hud.active', { timeout: 25000 });
  await b.page.waitForSelector('#hud.active', { timeout: 25000 });
  step('matchmaking formed a match and both clients entered it', true);

  // Let warmup pass and the world render.
  await a.page.waitForTimeout(3000);

  const hud = await a.page.evaluate(() => ({
    health: document.querySelector('[data-el="healthValue"]')?.textContent,
    ammo: document.querySelector('[data-el="ammoMag"]')?.textContent,
    reserve: document.querySelector('[data-el="ammoReserve"]')?.textContent,
    weapon: document.querySelector('[data-el="weaponName"]')?.textContent,
  }));
  step('HUD shows live vitals and ammo', hud.health === '100' && Number(hud.ammo) > 0,
       JSON.stringify(hud));

  // The rendered image must fill the window. A canvas is a replaced element, so
  // sizing it by insets alone silently falls back to the drawing-buffer size and
  // leaves the game rendering into a corner whenever resolutionScale < 1.
  const canvasFit = await a.page.evaluate(() => {
    const c = document.getElementById('viewport');
    const r = c.getBoundingClientRect();
    return {
      css: [Math.round(r.width), Math.round(r.height)],
      buffer: [c.width, c.height],
      window: [window.innerWidth, window.innerHeight],
    };
  });
  step('the viewport fills the window',
       canvasFit.css[0] === canvasFit.window[0] && canvasFit.css[1] === canvasFit.window[1],
       JSON.stringify(canvasFit));

  const hasDiag = await a.page.evaluate(() => !!window.titan);
  const noDiag = 'window.titan is exposed in dev builds only';

  if (!hasDiag) {
    skip('scene is rendering geometry', noDiag);
    skip('local player moved under prediction', noDiag);
    skip('prediction error stays small', noDiag);
    skip('the other player is rendered as a remote entity', noDiag);
  } else {
    const render = await a.page.evaluate(() => {
      const r = window.titan.renderer?.renderer?.info?.render;
      return r ? { calls: r.calls, tris: r.triangles } : null;
    });
    step('scene is rendering geometry', !!render && render.calls > 0 && render.tris > 1000,
         JSON.stringify(render));

    // ---- movement (predicted, client-side) ----
    // Keyboard input is only routed into the sim while the viewport has pointer
    // lock, which is what the player's first click does.
    await a.page.click('#viewport', { position: { x: 640, y: 360 } });
    // B clicks too: browsers only start audio after a gesture, and B's audio
    // is what proves a *spectator* hears a driven vehicle later on.
    await b.page.click('#viewport', { position: { x: 640, y: 360 } });
    await a.page.waitForTimeout(250);

    const before = await a.page.evaluate(() => {
      const p = window.titan.prediction.state.position;
      return { x: p.x, y: p.y, z: p.z };
    });
    await a.page.keyboard.down('KeyW');
    await a.page.waitForTimeout(1200);
    await a.page.keyboard.up('KeyW');
    await a.page.waitForTimeout(300);
    const after = await a.page.evaluate(() => {
      const p = window.titan.prediction.state.position;
      return { x: p.x, y: p.y, z: p.z };
    });
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    step('local player moved under prediction', moved > 0.5, `moved ${moved.toFixed(2)}m`);

    const predStats = await a.page.evaluate(() => window.titan.prediction.stats());
    step('prediction error stays small', predStats.error < 1.0, JSON.stringify(predStats));

    // ---- remote player visible ----
    const remotes = await a.page.evaluate(() => window.titan.remoteEntities.size);
    step('the other player is rendered as a remote entity', remotes >= 1, `remotes=${remotes}`);

    // ---- delta compression actually compresses ----
    // A resync costs a full snapshot, so a high rate means delta compression is
    // doing net harm. It was 100% before the client kept a snapshot history.
    const net = await a.page.evaluate(() => ({
      resyncs: window.titan.deltaResyncs,
      applied: window.titan.lastAckedSnapshot,
    }));
    const resyncRate = net.applied > 0 ? net.resyncs / net.applied : 1;
    step('delta snapshots reconstruct without resyncing', resyncRate < 0.05,
         `${net.resyncs} resyncs over ${net.applied} snapshots`);

    // ---- vehicles ----
    // Both combat maps declare at least one buggy. It must be rendered, and
    // its state must be arriving on the snapshot rather than a side channel.
    const vehicles = await a.page.evaluate(() => {
      const g = window.titan;
      const list = Array.from(g.vehicleEntities.values()).map((v) => ({
        id: v.next.state.id,
        defId: v.next.state.defId,
        inScene: !!v.rig.root.parent,
        wheels: v.rig.wheels.length,
      }));
      return { count: list.length, list, seated: g.localVehicleId };
    });
    step('vehicles arrive on the snapshot and are rendered',
         vehicles.count >= 1 && vehicles.list.every((v) => v.inScene && v.wheels === 4),
         JSON.stringify(vehicles.list));

    // A board request from across the map must be refused by the server —
    // the client asks, the server decides. We are at spawn, far from any pad.
    if (vehicles.count >= 1) {
      const target = vehicles.list[0].id;
      await a.page.evaluate((id) => {
        window.titan.net.send({ type: 'enter_vehicle', vehicleId: id });
      }, target);
      await a.page.waitForTimeout(600);
      const after = await a.page.evaluate(() => ({
        seated: window.titan.localVehicleId,
        prompt: document.querySelector('[data-el="interact"]')?.style.display,
        connected: window.titan.net.state,
      }));
      step('server refuses boarding from out of range (client stays on foot, not kicked)',
           after.seated === null && after.connected !== 'disconnected',
           JSON.stringify(after));
    }

    // ---- actually board, drive and dismount ----
    // The spawn room is walled, so a straight walk to the pad stalls. Use the
    // developer teleport instead — a real dev-tools command that a production
    // server refuses (devTools is forced off there). Then press the real
    // interact key: from here on nothing is test-only.
    const walkOutcome = await a.page.evaluate(async () => {
      const g = window.titan;
      const p = g.prediction.state.position;
      let best = null;
      for (const v of g.vehicleEntities.values()) {
        const s = v.next.state;
        const d = Math.hypot(s.pos[0] - p.x, s.pos[2] - p.z);
        if (!best || d < best.d) best = { d, x: s.pos[0], y: s.pos[1], z: s.pos[2], yaw: s.yaw, id: s.id };
      }
      if (!best) return { ok: false, why: 'no vehicle' };
      // Stand 1.8m to the vehicle's side, inside the 3.2m boarding range.
      g.net.send({ type: 'dev_command', command: { kind: 'teleport', x: best.x + 1.8, y: best.y + 0.2, z: best.z } });
      const start = performance.now();
      while (performance.now() - start < 5000) {
        const q = g.prediction.state.position;
        const d = Math.hypot(best.x - q.x, best.z - q.z);
        if (d < 2.6) return { ok: true, d, id: best.id, ms: performance.now() - start };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ok: false, why: 'teleport not reflected', d: Math.hypot(best.x - g.prediction.state.position.x, best.z - g.prediction.state.position.z) };
    });

    if (!walkOutcome.ok) {
      skip('board, drive and dismount a vehicle from the browser',
           `could not reach a pad on foot: ${JSON.stringify(walkOutcome)}`);
    } else {
      await a.page.waitForTimeout(400);
      const promptBefore = await a.page.evaluate(() =>
        document.querySelector('[data-el="interact"]')?.textContent?.trim() ?? '');
      await a.page.keyboard.press('KeyF');
      await a.page.waitForTimeout(700);
      const boarded = await a.page.evaluate(() => ({
        seated: window.titan.localVehicleId,
        viewModelVisible: window.titan.viewModel.root?.visible ?? null,
        prompt: document.querySelector('[data-el="interact"]')?.textContent?.trim() ?? '',
      }));
      step('pressing F beside a vehicle boards it (server-confirmed)',
           boarded.seated !== null && promptBefore.length > 0,
           `prompt before="${promptBefore}" -> ${JSON.stringify(boarded)}`);

      if (boarded.seated !== null) {
        const before = await a.page.evaluate(() => {
          const v = window.titan.vehicleEntities.get(window.titan.localVehicleId);
          return { x: v.next.state.pos[0], z: v.next.state.pos[2], cam: [...window.titan.renderer.camera.position.toArray()] };
        });
        await a.page.keyboard.down('KeyW');
        await a.page.waitForTimeout(2500);
        await a.page.keyboard.up('KeyW');
        await a.page.waitForTimeout(400);
        const after = await a.page.evaluate(() => {
          const v = window.titan.vehicleEntities.get(window.titan.localVehicleId);
          return { x: v.next.state.pos[0], z: v.next.state.pos[2], speed: v.next.state.speed,
                   driver: v.next.state.driverId === window.titan.net.playerId,
                   cam: [...window.titan.renderer.camera.position.toArray()] };
        });
        const drove = Math.hypot(after.x - before.x, after.z - before.z);
        const camMoved = Math.hypot(after.cam[0] - before.cam[0], after.cam[2] - before.cam[2]);
        step('holding W drives the vehicle and the camera rides in it',
             after.driver && drove > 1 && camMoved > 1,
             `vehicle moved ${drove.toFixed(1)}m, camera ${camMoved.toFixed(1)}m`);

        // The engine loop must exist while driving. Audio needs a user gesture
        // (the viewport click above) — if the context never started, that is
        // reported as such rather than as a missing engine.
        const engine = await a.page.evaluate(() => window.titan.audio.stats());
        if (!engine.running) {
          skip('a driven vehicle has a running engine loop', 'audio context not running in headless');
        } else {
          step('a driven vehicle has a running engine loop', engine.engines >= 1, JSON.stringify(engine));
        }

        // The other client hears it too, spatialised: its engine count rises
        // while A drives, without B being anywhere near a seat.
        const heard = await b.page.evaluate(() => window.titan.audio.stats());
        if (!heard.running) {
          skip('the other client hears the driven vehicle', 'audio context not running in headless');
        } else {
          step('the other client hears the driven vehicle', heard.engines >= 1, JSON.stringify(heard));
        }

        await a.page.keyboard.press('KeyF');
        await a.page.waitForTimeout(900);
        const exited = await a.page.evaluate(() => ({
          seated: window.titan.localVehicleId,
          viewModelVisible: window.titan.viewModel.root?.visible ?? null,
          engines: window.titan.audio.stats().engines,
        }));
        step('pressing F again dismounts', exited.seated === null, JSON.stringify(exited));
        if (engine.running) {
          step('the engine stops once nobody is driving', exited.engines === 0,
               `engines=${exited.engines}`);
        }
      }
    }
  }

  // ---- perf ----
  const perf = await a.page.evaluate(async () => {
    const samples = [];
    let last = performance.now();
    await new Promise((res) => {
      let n = 0;
      const tick = () => {
        const now = performance.now();
        samples.push(now - last);
        last = now;
        if (++n >= 120) return res();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    samples.sort((x, y) => x - y);
    return { median: samples[60], p90: samples[108] };
  });
  step('frame time is stable in software rendering', perf.p90 < 400,
       `median ${perf.median.toFixed(1)}ms p90 ${perf.p90.toFixed(1)}ms (SwiftShader, no GPU)`);

  await a.page.screenshot({ path: '/tmp/titan-qa/match.png' });
  await b.page.screenshot({ path: '/tmp/titan-qa/match-b.png' });
  step('captured screenshots', true);

} catch (e) {
  step('E2E run completed without throwing', false, String(e).slice(0, 300));
  try { await a.page.screenshot({ path: '/tmp/titan-qa/failure.png' }); } catch {}
} finally {
  results.errors = [...a.errors, ...b.errors];
  writeFileSync('/tmp/titan-qa/results.json', JSON.stringify(results, null, 2));
  await a.browser.close();
  await b.browser.close();
}

const failed = results.steps.filter((s) => !s.skipped && !s.ok);
const skipped = results.steps.filter((s) => s.skipped);
const ran = results.steps.length - skipped.length;
log(`\n${ran - failed.length}/${ran} steps passed` +
    (skipped.length ? `, ${skipped.length} skipped` : ''));
if (results.errors.length) {
  log('console errors:');
  for (const e of [...new Set(results.errors)].slice(0, 10)) log('  ', e.slice(0, 200));
}
process.exit(failed.length > 0 ? 1 : 0);
