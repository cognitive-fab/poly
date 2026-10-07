// PT10g, PL6825 (M9): token-shaped strings, which no configuration poly reads may hold. The shapes are the documented
// prefixes of common providers' secrets, a JSON Web Token and a PEM private key; a secret in another shape is not found,
// and that limit is stated in PT10g.
const SHAPES: [string, RegExp][] = [
  ['a Stripe secret or restricted key', /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/],
  ['a Slack token', /\bxox[abpr]-[0-9A-Za-z-]{10,}/],
  ['a Google access token', /\bya29\.[0-9A-Za-z_-]{20,}/],
  ['a GitHub token', /\bgh[pousr]_[0-9A-Za-z]{30,}/],
  ['an AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['a JSON Web Token', /\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/],
  ['a PEM private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** What a text holds that has the shape of a secret, by kind only; the value is never returned (PL6825). */
export function secretShapes(text: string): string[] {
  return SHAPES.filter(([, re]) => re.test(text)).map(([what]) => what);
}
