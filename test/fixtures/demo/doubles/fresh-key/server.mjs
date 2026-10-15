import { startDouble } from '../_double.mjs';
startDouble({ keys: 'fresh', retries: 3 }); // refunds twice: a fresh key on every attempt is no key (DAC9)
