// Fixture: Headers in a variable, not a literal object in the fetch call.
// The lint cannot determine if the headers include Idempotency-Key, so it reports undecided.
export async function refund(key: string): Promise<void> {
  const headers = buildHeaders(key);
  await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers,
    body: 'charge=ch_1&amount=4000',
  });
}

function buildHeaders(key: string): Record<string, string> {
  return {
    'Authorization': 'Bearer secret',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Idempotency-Key': key,
  };
}
