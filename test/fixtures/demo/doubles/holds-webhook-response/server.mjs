// A double that receives a webhook but never sends a response: it reads the body and holds the connection.
// This tests the webhookMs timeout of the replay driver (DB6 item 9, section E).
// The server exits after 30 seconds to ensure the test process does not hang indefinitely.
import http from 'node:http';

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // Read the body but never send a response. The driver will timeout waiting.
  });
}).listen(Number(process.env.PORT), '127.0.0.1');

// Safety exit after 30 seconds, so this process does not hang forever if the test hangs.
setTimeout(() => process.exit(0), 30000);
