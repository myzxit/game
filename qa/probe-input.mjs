// Focused diagnostic: why does keyboard input not reach the simulation?
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => {
  if (/\[(Game|Net)\]/.test(m.text())) console.log('  ·', m.text().slice(0, 120));
});
await page.goto('http://127.0.0.1:5173/?server=ws://127.0.0.1:8080', { waitUntil: 'networkidle' });

await page.waitForSelector('#screen-login.active', { timeout: 15000 });
await page.fill('[data-el="loginName"]', 'Probe1');
await page.click('[data-el="loginEnter"]');
await page.waitForSelector('#screen-menu.active', { timeout: 15000 });
await page.click('[data-mode="tdm"]');
await page.click('[data-el="playButton"]');

// TDM needs a second body; spin up a bot client purely to fill the queue.
const page2 = await browser.newPage({ viewport: { width: 640, height: 480 } });
await page2.goto('http://127.0.0.1:5173/?server=ws://127.0.0.1:8080', { waitUntil: 'networkidle' });
await page2.waitForSelector('#screen-login.active', { timeout: 15000 });
await page2.fill('[data-el="loginName"]', 'Probe2');
await page2.click('[data-el="loginEnter"]');
await page2.waitForSelector('#screen-menu.active', { timeout: 15000 });
await page2.click('[data-mode="tdm"]');
await page2.click('[data-el="playButton"]');

await page.waitForSelector('#hud.active', { timeout: 25000 });
await page.waitForTimeout(3500);

const probe = () =>
  page.evaluate(() => {
    const g = window.titan;
    const input = g.input;
    return {
      screen: g.screens.activeScreen,
      alive: g.alive,
      inputEnabled: input.enabled,
      pointerLocked: input.hasPointerLock,
      lockElement: document.pointerLockElement?.id ?? null,
      pos: { ...g.prediction.state.position },
    };
  });

const netProbe = () =>
  page.evaluate(() => ({
    resyncs: window.titan.deltaResyncs,
    acked: window.titan.lastAckedSnapshot,
    history: window.titan.snapshotHistory.size,
  }));
console.log('net after 3.5s:', JSON.stringify(await netProbe()));
await page.waitForTimeout(6000);
console.log('net after 9.5s:', JSON.stringify(await netProbe()));
console.log('before click :', JSON.stringify(await probe()));
await page.click('#viewport', { position: { x: 640, y: 360 } });
await page.waitForTimeout(400);
console.log('after click  :', JSON.stringify(await probe()));

await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyW');
await page.waitForTimeout(300);
console.log('after W      :', JSON.stringify(await probe()));

await browser.close();
