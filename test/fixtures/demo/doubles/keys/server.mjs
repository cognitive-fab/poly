import { startDouble } from '../_double.mjs';
startDouble({ keys: 'stable', retries: 3 }); // refunds once: the same key on every attempt
