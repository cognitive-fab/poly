import { startDouble } from '../_double.mjs';
startDouble({ keys: 'none', retries: 3, dedupe: true }); // refunds twice under the fault, and remembers the webhook it handled, as a real build does
