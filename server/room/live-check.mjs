// ---------------------------------------------------------------------------
// The manual checklist in README.md, automated — two WebSocket clients against
// the real worker running under `wrangler dev`.
//
// NOT A SHIP GATE, and deliberately not a `test:*` script. It needs a server on
// a port, and ship gates run with no TTY and no network; a harness that quietly
// depends on one passes on your machine and fails in the dark. It lives here
// beside the worker instead, and you run it by hand:
//
//   npx wrangler dev            # in this directory
//   node server/room/live-check.mjs
//
// AGAINST THE DEPLOYED WORKER, pass its origin — the same checks, run over TLS
// against the real edge. Worth doing once after every deploy: local Durable
// Objects are miniflare's, and the rejoin grace window here is the one thing
// that depends on storage actually persisting across a hibernation the local
// runtime may never perform.
//
//   node server/room/live-check.mjs https://seal-survivor-room.<sub>.workers.dev
//
// What it covers is exactly what room-relay.js's harness cannot: the routing,
// the WebSocket upgrade, the hibernation handlers, and whether a seat
// reservation really survives in Durable Object storage. Node 22's built-in
// WebSocket, so there is nothing to install.
// ---------------------------------------------------------------------------
// The origin under test. `wrangler dev` by default, so the bare command in the
// header keeps working; an argument replaces it, and the ws scheme is derived
// rather than given, because a wss origin typed as ws is a connection that
// fails with an error about the handshake and nothing about the scheme.
const ORIGIN = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const BASE = ORIGIN;
const WS = ORIGIN.replace(/^http/, 'ws');

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'ok   ' : 'FAIL '} ${label}${!cond && detail ? `\n          ${detail}` : ''}`);
  if (!cond) failures += 1;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(code, role, { name = '', build = 'testbuild' } = {}) {
  const url = `${WS}/room/${code}?role=${role}&name=${encodeURIComponent(name)}&build=${build}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const got = [];
  const bin = [];
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') got.push(JSON.parse(e.data));
    else bin.push(new Uint8Array(e.data));
  });
  const opened = new Promise((res) => {
    ws.addEventListener('open', () => res('open'));
    ws.addEventListener('error', () => res('error'));
    ws.addEventListener('close', () => res('closed'));
  });
  return { ws, got, bin, opened };
}

console.log(`\nthe live worker, at ${ORIGIN}\n`);

// 1. a code
const res = await fetch(`${BASE}/new`, { method: 'POST' });
const { code } = await res.json();
check('POST /new returns a code', /^[A-Z]{5}$/.test(code ?? ''), JSON.stringify(code));

const second = (await (await fetch(`${BASE}/new`, { method: 'POST' })).json()).code;
check('a second call returns a different code', second !== code, `${code} vs ${second}`);

// 2. a guest cannot open a room nobody is hosting
{
  const g = connect(second, 'guest');
  const how = await g.opened;
  check('joining a code nobody hosts is refused', how !== 'open', `socket said ${how}`);
}

// 3. host then guest
const host = connect(code, 'host', { name: 'Ethan' });
check('the host socket opens', (await host.opened) === 'open');
await wait(150);

const guest = connect(code, 'guest', { name: 'Pal' });
check('the guest socket opens', (await guest.opened) === 'open');
await wait(250);

{
  const last = host.got.filter((m) => m.t === 'room').at(-1);
  check('the host is told its own role', last?.you === 'host', JSON.stringify(last));
  check('the host sees both members', last?.members?.length === 2, JSON.stringify(last?.members));
  check('names survive the trip', last?.members?.some((m) => m.name === 'Pal'));

  const gl = guest.got.filter((m) => m.t === 'room').at(-1);
  check('the guest is told it is the guest', gl?.you === 'guest', JSON.stringify(gl));
  check('the guest sees the host', gl?.members?.some((m) => m.role === 'host' && m.name === 'Ethan'));
}

// 4. a third joiner
{
  const third = connect(code, 'guest');
  const how = await third.opened;
  check('a third joiner is refused', how !== 'open', `socket said ${how}`);
}

// 5. a stale build
{
  const stale = connect(code, 'guest', { build: 'deadbeef' });
  const how = await stale.opened;
  check('a different build is refused', how !== 'open', `socket said ${how}`);
}

// 6. ping is answered by the SERVER
{
  host.ws.send(JSON.stringify({ t: 'ping', id: 7 }));
  await wait(200);
  const pong = host.got.find((m) => m.t === 'pong' && m.id === 7);
  check('ping is answered with a pong carrying the id', !!pong, JSON.stringify(host.got.at(-1)));
  check('...and the server stamps it', typeof pong?.serverAt === 'number');
  check('the peer never sees the ping', !guest.got.some((m) => m.t === 'ping' || m.t === 'pong'));
}

// 7. binary both ways, and never an echo
{
  const snapshot = new Uint8Array([0x20, 1, 2, 3, 4, 5]);
  const input = new Uint8Array([0x10, 1, 9, 9]);
  host.ws.send(snapshot);
  guest.ws.send(input);
  await wait(250);
  check('a snapshot reaches the guest', guest.bin.some((b) => b[0] === 0x20 && b[5] === 5),
    JSON.stringify(guest.bin.map((b) => [...b])));
  check('input reaches the host', host.bin.some((b) => b[0] === 0x10 && b[3] === 9));
  check('the host never hears its own snapshot', !host.bin.some((b) => b[0] === 0x20));
  check('the guest never hears its own input', !guest.bin.some((b) => b[0] === 0x10));
}

// 8. ready is lobby state, and is broadcast
{
  guest.ws.send(JSON.stringify({ t: 'ready', ready: true }));
  await wait(250);
  const last = host.got.filter((m) => m.t === 'room').at(-1);
  check('the host sees the guest go ready',
    last?.members?.find((m) => m.role === 'guest')?.ready === true, JSON.stringify(last?.members));
}

// 9. an unrelayable type is dropped in silence
{
  const before = guest.got.length;
  host.ws.send(JSON.stringify({ t: 'rm -rf', payload: 'nope' }));
  await wait(200);
  check('an unknown control type reaches nobody',
    !guest.got.slice(before).some((m) => m.t === 'rm -rf'));
}

let rejoined = null;

// 10. a guest that drops has its seat HELD — the one part of the object no
//      harness can reach, because the reservation lives in DO storage rather
//      than on the sockets.
{
  guest.ws.close();
  await wait(400);
  const gone = host.got.find((m) => m.t === 'peerGone' && m.role === 'guest');
  check('the host is told the guest dropped, with a grace window', gone?.graceMs > 0, JSON.stringify(gone));

  rejoined = connect(code, 'guest');  // no name: the reservation should still hold it
  check('the seat is rejoinable', (await rejoined.opened) === 'open');
  await wait(300);
  const last = host.got.filter((m) => m.t === 'room').at(-1);
  check('the room holds two again', last?.members?.length === 2, JSON.stringify(last?.members));
  check('and the name the lobby knew survived the drop',
    last?.members?.some((m) => m.role === 'guest' && m.name === 'Pal'), JSON.stringify(last?.members));
}

// 11. the host going ends it for the guest
{
  host.ws.close();
  await wait(400);
  const gone = rejoined.got.find((m) => m.t === 'peerGone' && m.role === 'host');
  check('the guest is told the host went', !!gone, JSON.stringify(rejoined.got.at(-1)));
  check('...with no grace, because the host IS the simulation', gone?.graceMs === 0);
}

// 12. a malformed code never reaches a room
{
  const bad = await fetch(`${BASE}/room/AB0CD`);
  check('a code outside the alphabet is a 400', bad.status === 400, `got ${bad.status}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
