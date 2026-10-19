// The guest of the dry run. It starts the launcher, plays one or more guests over HTTP (each guest is a browser session with its own
// cookie), prints what each guest's page receives (the server-sent events of /api/events), and then the presenter's `staff` and
// `status`. It exists because the first dry run of Step 12 checked only that the room accepted a message (HTTP 200) and never that a
// reply reached the page (DF11). It reads no key and sets none.
//
//   node docs/demo/rehearsal-dry-run/play-room.mjs <port> <launcher flags...> -- <guest>=<message> [<guest>=<message> ...]
//
// <guest> is 1, 2, ... : the first session to join is guest 1, the second guest 2. A message waits for the room's reply (or 12 s).
import { spawn } from 'node:child_process';
import http from 'node:http';

const args = process.argv.slice(2);
const port = Number(args.shift());
const split = args.indexOf('--');
const launcherArgs = args.slice(0, split);
const script = args.slice(split + 1).map((s) => ({ guest: Number(s.slice(0, s.indexOf('='))), text: s.slice(s.indexOf('=') + 1) }));
const child = spawn(process.execPath, ['demo/launch.mjs', ...launcherArgs, '--port', String(port)], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let log = '';
const show = (c) => { const t = c.toString('utf8'); log += t; process.stdout.write(t); };
child.stdout.on('data', show);
child.stderr.on('data', show);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (re, ms) => { const t0 = Date.now(); while (!re.test(log)) { if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}\n${log.slice(-600)}`); await sleep(200); } };
const call = (method, path, cookie, body) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (rs) => { let d = ''; rs.on('data', (c) => (d += c)); rs.on('end', () => res({ status: rs.statusCode, headers: rs.headers, body: d })); });
  r.on('error', rej); if (body) r.write(JSON.stringify(body)); r.end();
});

const guests = new Map(); // number -> { cookie, replies }
try {
  await until(/Presenter prompt/, 900_000);
  for (const { guest, text } of script) {
    if (!guests.has(guest)) {
      const first = await call('GET', '/');
      const setCookie = first.headers['set-cookie']?.[0];
      if (!setCookie) throw new Error(`the room set no session cookie (HTTP ${first.status}): ${first.body.slice(0, 200)}`);
      const cookie = setCookie.split(';')[0];
      const g = { cookie, replies: 0 };
      http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { cookie } }, (rs) => {
        // A line can arrive in two chunks: keep the unfinished tail until its newline comes.
        let tail = '';
        rs.setEncoding('utf8'); // a character split across two chunks is decoded whole
        rs.on('data', (c) => {
          const lines = (tail + c.toString()).split('\n');
          tail = lines.pop();
          for (const l of lines) if (l.startsWith('data:')) { g.replies += JSON.parse(l.slice(5)).kind === 'reply' ? 1 : 0; console.log(`<<< guest ${guest} page: ${l.slice(5).trim()}`); }
        });
      });
      guests.set(guest, g);
    }
    const g = guests.get(guest);
    const before = g.replies;
    console.log(`\n>>> guest ${guest} says: ${text}`);
    const r = await call('POST', '/api/say', g.cookie, { text });
    console.log(`>>> the room accepted it: HTTP ${r.status} ${r.body}`);
    for (let k = 0; k < 60 && g.replies === before && r.status === 200; k++) await sleep(200);
    await sleep(1500);
    if (g.replies === before) console.log(`!!! guest ${guest} got NO reply on the page for: ${text}`);
    await sleep(4000); // the room allows one message in 5 seconds for a guest
    if (r.status === 503) break;
  }
  child.stdin.write('staff\n');
  await sleep(800);
  child.stdin.write('status\n');
  await sleep(800);
  child.stdin.write('quit\n');
  await new Promise((r) => child.on('exit', r));
} finally {
  child.kill();
}
