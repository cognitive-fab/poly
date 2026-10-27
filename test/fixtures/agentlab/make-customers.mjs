// Writes customers.json: 50 made-up customers, deterministic, for the recorded customer-records server. Run once.
import { writeFileSync } from 'node:fs';

const first = ['Ada', 'Bram', 'Cora', 'Dev', 'Elin', 'Femi', 'Gus', 'Hana', 'Ivo', 'Jun'];
const last = ['Alder', 'Birch', 'Cedar', 'Dunn', 'Ember'];
const cities = ['Oslo', 'Lima', 'Pune', 'Kyiv', 'Accra'];
const out = [];
for (let i = 0; i < 50; i++) {
  const f = first[i % 10];
  const l = last[Math.floor(i / 10)];
  out.push({ id: `C${String(i + 1).padStart(3, '0')}`, name: `${f} ${l}`, email: `${f}.${l}@example.test`.toLowerCase(), phone: `+1-555-01${String(i).padStart(2, '0')}`, city: cities[i % 5] });
}
writeFileSync(new URL('./customers.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
