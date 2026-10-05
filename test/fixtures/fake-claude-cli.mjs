// A stand-in for the claude CLI, for the headless provider's launcher tests (decisions-m6.md): no model, no login.
// With FAKE_CLAUDE_MODE=echo it records that it started, reads its whole stdin and prints it back in a ```poly block;
// with FAKE_CLAUDE_MODE=exit it exits at once with code 3, without reading stdin.
import { writeFileSync } from 'node:fs';

if (process.env.FAKE_CLAUDE_STARTED) writeFileSync(process.env.FAKE_CLAUDE_STARTED, process.argv.slice(2).join(' '));
if (process.env.FAKE_CLAUDE_MODE === 'exit') process.exit(3);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => { process.stdout.write('```poly\n' + input + '\n```\n'); });
