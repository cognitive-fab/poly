// Fixture: A handler that issues a refund with a fresh key on every call.
// The key is a fresh randomUUID() on each invocation, so it violates the path-level guarantee
// (the poly check with no-reissue property would catch this).
import { randomUUID } from 'node:crypto';

export async function confirm(): Promise<void> {
  const freshKey = randomUUID();
  await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer secret',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': freshKey,
    },
    body: 'charge=ch_1&amount=4000',
  });
}
