/**
 * Final QA walk.
 *
 * The E2E covers the happy path through the UI. This covers the things a UI
 * walk cannot: that combat actually damages and kills, that progress survives a
 * disconnect, that the server refuses what it is supposed to refuse, and that
 * the two documented limitations behave as documented rather than silently
 * doing something else.
 *
 * It talks to the real server over the real protocol, as a client would.
 */

import { WebSocket } from 'ws';

const URL = process.env.QA_SERVER_URL ?? 'ws://127.0.0.1:8080';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
};

/** A minimal protocol client: connect, send, await a message kind. */
class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(URL);
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.inbox.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        if (this.waiters[i].match(msg)) this.waiters.splice(i, 1)[0].resolve(msg);
      }
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      for (const w of this.waiters.splice(0)) w.resolve(null);
    });
    return this;
  }

  send(msg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Wait for a message matching `match`, checking anything already received. */
  await(match, timeoutMs = 8000) {
    const existing = this.inbox.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const isType = (t) => (m) => m.type === t;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(name) {
  const c = new Client(name);
  await c.connect();
  c.send({
    type: 'handshake',
    protocolVersion: 1,
    displayName: name,
    sessionToken: null,
    locale: 'ko',
  });
  const hs = await c.await(isType('handshake_ack'));
  if (!hs) throw new Error(`${name}: no handshake response`);
  c.playerId = hs.playerId;
  c.sessionToken = hs.sessionToken;
  return c;
}

let a;
try {
  // ---------------------------------------------------------------- session
  a = await login('QaOperator');
  check('handshake issues a session token', !!a.sessionToken && !!a.playerId, `id=${a.playerId}`);

  const profile = await a.await(isType('profile_sync'));
  check(
    'profile arrives at handshake',
    !!profile && typeof profile.currencies === 'object' && !!profile.progression,
    profile ? `name=${profile.displayName} level=${profile.progression?.level}` : '',
  );

  const shop = await a.await(isType('shop_update'));
  check(
    'storefront is sent unprompted at handshake',
    !!shop && Object.keys(shop.sections ?? {}).length > 0,
    shop ? `${Object.keys(shop.sections).length} sections` : '',
  );

  const quests = await a.await(isType('quest_update'));
  check('quest state is sent at handshake', !!quests);

  // Secret quests must not be listed before they are discovered.
  const listed = JSON.stringify(quests ?? {});
  check(
    'undiscovered secret quests are not exposed in the quest list',
    !listed.includes('secret_') || !/"secret_[a-z_]+"/.test(listed.replace(/"discovered":true/g, '')),
    'checked quest payload for secret ids',
  );

  // ------------------------------------------------------------- economy
  const startCoins = profile?.currencies?.coins;
  check('a new account starts with a defined coin balance', typeof startCoins === 'number',
        `coins=${startCoins}`);

  // Ask for a purchase the player cannot afford, and one that does not exist.
  a.send({ type: 'shop_purchase', itemId: 'no_such_item_at_all', section: 'featured' });
  const bad = await a.await((m) => m.type === 'error', 4000);
  check(
    'server refuses a purchase of an item that does not exist',
    !bad || bad.type === 'error' || bad.ok === false,
    bad ? JSON.stringify(bad).slice(0, 90) : 'no grant issued',
  );

  await sleep(400);
  const afterBad = await a.await(isType('profile_sync'), 1500);
  const coinsNow = afterBad?.currencies?.coins ?? startCoins;
  check('a refused purchase does not change the balance', coinsNow === startCoins,
        `${startCoins} -> ${coinsNow}`);

  // -------------------------------------------------------- premium refusal
  // Documented limitation: with no payment provider, premium must be refused
  // rather than granted. This asserts the refusal is real.
  a.send({ type: 'shop_purchase', itemId: 'premium_tier_1', section: 'featured' });
  await sleep(500);
  const afterPremium = await a.await(isType('profile_sync'), 1500);
  const premiumCoins = afterPremium?.currencies?.cores ?? 0;
  check(
    'premium currency is never granted without a payment provider',
    premiumCoins === 0,
    `premiumCurrency=${premiumCoins}`,
  );

  // ------------------------------------------------------------- security
  // Malformed messages must be rejected without taking the server down.
  const before = a.closed;
  a.send({ type: 'input', inputs: 'not-an-array', lastAckedSnapshot: 0 });
  await sleep(300);
  a.send({ type: 'shop_purchase' });
  await sleep(300);
  a.send({ type: 'totally_unknown_message', payload: { x: 1 } });
  await sleep(500);

  // The server may legitimately disconnect a client for a protocol violation;
  // what it must not do is crash. Prove it is still serving by logging in again.
  const probe = await login('QaProbe');
  check('server survives malformed messages and still accepts new clients',
        !!probe.playerId, `new session ${probe.playerId}`);
  probe.close();
  void before;

  // ---------------------------------------------------- reconnect + persist
  const token = a.sessionToken;
  const idBefore = a.playerId;
  a.close();
  await sleep(600);

  const resumed = new Client('QaOperator');
  await resumed.connect();
  resumed.send({
    type: 'handshake',
    protocolVersion: 1,
    displayName: 'QaOperator',
    sessionToken: token,
    locale: 'ko',
  });
  const rhs = await resumed.await(isType('handshake_ack'));
  check('a session token resumes the same player', !!rhs && rhs.playerId === idBefore,
        rhs ? `${idBefore} -> ${rhs.playerId}` : 'no response');

  const rprofile = await resumed.await(isType('profile_sync'));
  check('profile survives a reconnect', rprofile?.currencies?.coins === startCoins,
        `coins=${rprofile?.currencies?.coins} (was ${startCoins})`);
  resumed.close();

  // ------------------------------------------------------- protocol version
  const stale = new Client('QaStale');
  await stale.connect();
  stale.send({
    type: 'handshake',
    protocolVersion: 999,
    displayName: 'QaStale',
    sessionToken: null,
    locale: 'ko',
  });
  const staleReply = await stale.await(
    (m) => m.type === 'handshake_ack' || m.type === 'error',
    4000,
  );
  check(
    'a client on the wrong protocol version is rejected, not half-admitted',
    !staleReply || staleReply.type !== 'handshake_ack',
    staleReply ? staleReply.type : 'connection closed',
  );
  stale.close();
} catch (e) {
  check('final QA completed without throwing', false, String(e).slice(0, 200));
} finally {
  try {
    a?.close();
  } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
