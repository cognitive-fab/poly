// Child process spawned by parent.mjs.
// Writes its pid to pidFile, listens on PORT at 127.0.0.1, answers with 200.
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const pidFile = process.argv[2];
const port = Number(process.env.PORT);

// Write child pid
writeFileSync(pidFile, String(process.pid));

// Listen for requests
http.createServer((req, res) => {
  res.writeHead(200).end('ok');
}).listen(port, '127.0.0.1');

// Keep alive
setInterval(() => {}, 1 << 30);
