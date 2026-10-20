// Fixture: Three URL forms (plain string, template literal, concatenation), all keyed.
// Also includes a fourth call with lowercase 'idempotency-key' (should count as keyed).
// Also includes a GET call to /v1/charges which should NOT be counted.
export async function refund1(key: string): Promise<void> {
  // Plain string literal
  await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer secret',
      'Idempotency-Key': key,
    },
    body: 'charge=ch_1&amount=4000',
  });
}

export async function refund2(base: string, key: string): Promise<void> {
  // Template literal
  await fetch(`${base}/v1/refunds`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer secret',
      'Idempotency-Key': key,
    },
    body: 'charge=ch_2&amount=4000',
  });
}

export async function refund3(base: string, key: string): Promise<void> {
  // Concatenation
  await fetch(base + '/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer secret',
      'Idempotency-Key': key,
    },
    body: 'charge=ch_3&amount=4000',
  });
}

export async function refund4(key: string): Promise<void> {
  // Lowercase header name (should count as keyed, any case)
  await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer secret',
      'idempotency-key': key,
    },
    body: 'charge=ch_4&amount=4000',
  });
}

export async function getCharge(id: string): Promise<any> {
  // GET request (should NOT be counted as a refund call)
  const response = await fetch(`https://api.stripe.com/v1/charges/${id}`, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer secret',
    },
  });
  return response.json();
}
