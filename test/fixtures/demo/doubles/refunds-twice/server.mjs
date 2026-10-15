import { startDouble } from '../_double.mjs';
startDouble({ keys: 'none', retries: 3 }); // refunds twice: it retries with no key
