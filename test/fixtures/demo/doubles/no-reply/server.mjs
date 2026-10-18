// Never replies and never refunds.
import { writeFileSync, appendFileSync } from 'node:fs';
import http from 'node:http';

const logPath = process.argv[2];

// Initialize log
writeFileSync(logPath, JSON.stringify({ ev: 'start' }) + '\n');

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200).end('ok');
    try {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8')).entry[0].changes[0].value.messages[0];
      const text = message?.text?.body;
      if (!text) return;
      const id = message.id;
      const from = message.from;
      // Log inbound message
      appendFileSync(logPath, JSON.stringify({ ev: 'in', id, from, text }) + '\n');
      // Do not reply, do not refund
    } catch { /* not a message */ }
  });
}).listen(Number(process.env.PORT), '127.0.0.1');
