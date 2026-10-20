// Fixture: Three URL forms (plain string, template literal, concatenation), all unkeyed.
export async function refund1(): Promise<void> {
  // Plain string literal, no Idempotency-Key
  await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer secret',
    },
    body: 'charge=ch_1&amount=4000',
  });
}

export async function refund2(base: string): Promise<void> {
  // Template literal, no Idempotency-Key
  await fetch(`${base}/v1/refunds`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer secret',
    },
    body: 'charge=ch_2&amount=4000',
  });
}

export async function refund3(base: string): Promise<void> {
  // Concatenation, no Idempotency-Key
  await fetch(base + '/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer secret',
    },
    body: 'charge=ch_3&amount=4000',
  });
}
