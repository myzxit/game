// Focused diagnostic: is the buggy accelerating as its definition says?
// Teleports beside the first vehicle (dev command), boards, holds W and
// samples the authoritative speed/position every 250ms.
import { chromium } from 'playwright';
const URL = 'http://127.0.0.1:5173/?server=ws://127.0.0.1:8080';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
async function join(name) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#screen-login.active', { timeout: 15000 });
  await page.fill('[data-el="loginName"]', name);
  await page.click('[data-el="loginEnter"]');
  await page.waitForSelector('#screen-menu.active', { timeout: 15000 });
  await page.click('[data-mode="tdm"]');
  await page.click('[data-el="playButton"]');
  return page;
}
const a = await join('VProbe1');
const b = await join('VProbe2');
await a.waitForSelector('#hud.active', { timeout: 25000 });
await a.waitForTimeout(3500);
await a.click('#viewport', { position: { x: 480, y: 270 } });
await a.waitForTimeout(300);

const info = await a.evaluate(async () => {
  const g = window.titan;
  const v = Array.from(g.vehicleEntities.values())[0];
  const s = v.next.state;
  g.net.send({ type: 'dev_command', command: { kind: 'teleport', x: s.pos[0] + 1.8, y: s.pos[1] + 0.2, z: s.pos[2] } });
  // Wait until prediction reflects the teleport, else F fires before the prompt exists.
  const t0 = performance.now();
  while (performance.now() - t0 < 5000) {
    const q = g.prediction.state.position;
    if (Math.hypot(s.pos[0] - q.x, s.pos[2] - q.z) < 2.6) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 400));
  return { map: g.currentMap?.id, vehicle: { id: s.id, pos: s.pos, yaw: s.yaw } };
});
console.log('setup', JSON.stringify(info));
await a.keyboard.press('KeyF');
await a.waitForTimeout(800);
console.log('seated', await a.evaluate(() => window.titan.localVehicleId));

await a.keyboard.down('KeyW');
for (let i = 0; i < 12; i++) {
  await a.waitForTimeout(250);
  const s = await a.evaluate((t) => {
    const g = window.titan;
    const v = g.vehicleEntities.get(g.localVehicleId);
    if (!v) return null;
    const st = v.next.state;
    return { t, speed: +st.speed.toFixed(2), x: +st.pos[0].toFixed(2), z: +st.pos[2].toFixed(2), hp: st.health };
  }, i);
  console.log('sample', JSON.stringify(s));
}
await a.keyboard.up('KeyW');
await browser.close();
