// PT10g, PL6825 SECRET_IN_CONFIG: the eighth shape, an HTTP credential (the owner's ruling of 2026-11-02). The scheme is
// Bearer, bearer or BEARER (Basic, basic or BASIC) as a whole word, then one or more spaces or tabs, then a value of at
// least 12 characters drawn from letters, digits and -._~+/, with any = padding after it. A value that is one letter
// followed only by lower-case letters is a word and is not found. The kind is named "an HTTP credential (Bearer or Basic)".
// Written by a separate writer from the spec alone (rule 7a). No assertion message and no test title prints a value
// under test: each case is named by a label, so a found credential is never repeated by the reporter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretShapes } from '../packages/poly-check/dist/src/secrets.js';

const KIND = 'an HTTP credential (Bearer or Basic)';
// The spec does not state what secretShapes returns for each finding. A finding is read as its kind, either the string
// itself or its `kind` field; the calibration test below shows the reading works on a shape PL6825 already finds, so a
// red HTTP-credential test is the shape missing and not this helper misreading a finding.
const kindsOf = (s) => secretShapes(s).map((f) => (typeof f === 'string' ? f : f?.kind));

test('calibration: a Slack token is found and its kind is read as a Slack token', () => {
  const kinds = kindsOf(`xoxb-${'1234567890'}-abcdefghijkl`);
  assert.ok(kinds.length > 0, 'a Slack token is found');
  assert.ok(kinds.some((k) => typeof k === 'string' && /Slack token/.test(k)), `the kind is read: ${JSON.stringify(kinds.map((k) => typeof k))}`);
});

test('calibration: plain prose is not found', () => {
  assert.deepEqual(kindsOf('the adapter reads its secrets from the vault at run time'), []);
});

// The examples PT10g names, the three letter cases of each scheme, a tab, several spaces, = padding, and the boundary of
// 12 characters. Each is named by a label only.
const FOUND = [
  ['PT10g: Bearer and a JSON Web Token header', 'Bearer eyJhbGciOiJIUzI1NiJ9'],
  ['PT10g: Basic and a 12-character base64 value', 'Basic dXNlcjpwYXNz'],
  ['PT10g: Bearer and a 12-character value of letters and digits', 'Bearer abc123def456'],
  ['the scheme written Bearer', 'Bearer Q2xpZW50MTIzNDU2'],
  ['the scheme written bearer', 'bearer Q2xpZW50MTIzNDU2'],
  ['the scheme written BEARER', 'BEARER Q2xpZW50MTIzNDU2'],
  ['the scheme written Basic', 'Basic Q2xpZW50MTIzNDU2'],
  ['the scheme written basic', 'basic Q2xpZW50MTIzNDU2'],
  ['the scheme written BASIC', 'BASIC Q2xpZW50MTIzNDU2'],
  ['a tab between the scheme and the value', 'Bearer\tabc123def456'],
  ['several spaces between the scheme and the value', 'Bearer   abc123def456'],
  ['a space and a tab between the scheme and the value', 'Basic \tabc123def456'],
  ['a value with = padding', 'Basic dXNlcjE6cGFzcw=='],
  ['a value with a single = of padding', 'Basic dXNlcjE6cGFzczE='],
  ['a value with each of -._~+/', 'Bearer ab-c.d_e~f+g/h1'],
  ['a value that starts with an upper-case letter and holds a digit', 'Bearer Abcdefghijk1'],
  ['a value of upper-case letters alone', 'Bearer ABCDEFGHIJKL'],
  ['a value of one letter followed by mixed case', 'Bearer aBcDeFgHiJkL'],
  ['the credential after a header name', 'Authorization: Bearer abc123def456'],
  ['the credential inside a quoted string in source', "const headers = { Authorization: 'Bearer abc123def456' };"],
  ['the credential at the end of a line of prose', 'the token is Bearer abc123def456\n'],
];

for (const [label, text] of FOUND) {
  test(`PL6825: found as an HTTP credential: ${label}`, () => {
    const kinds = kindsOf(text);
    assert.ok(kinds.includes(KIND), `${label}: the kind named is "${KIND}" (kinds found: ${kinds.length})`);
  });
}

// The cases PT10g states are not found, and the limits it states. Each gives no finding of any kind.
const NOT_FOUND = [
  ['a comment that reads only the word Bearer', '// Bearer'],
  ['the word Bearer alone', 'Bearer'],
  ['the word Basic alone', 'Basic'],
  ['the phrase "the Bearer token"', 'the Bearer token'],
  ['the phrase "Bearer authentication"', 'Bearer authentication'],
  ['a comment "Bearer authentication"', '// uses Bearer authentication'],
  ['a capitalized word after the scheme', 'Bearer Authentication'],
  ['the phrase "Basic authentication"', 'Basic authentication is refused here'],
  // Written in single quotes, so the text is the template as source, not an interpolated value.
  ['a template that reads Authorization: Bearer ${token}', 'Authorization: Bearer ${token}'],
  ['a template literal in source', 'const h = { authorization: `Bearer ${token}` };'],
  ['a value of 11 characters', 'Bearer abc123def45'],
  ['a value of 11 characters with = padding', 'Basic dXNlcjpwYXN='],
  ['the scheme inside a longer word, before it', 'XBearer abc123def456'],
  ['the scheme inside a longer word, after it', 'Bearerish abc123def456'],
  ['the scheme inside a longer word, Basic', 'Basically abc123def456'],
  ['the scheme with no space before the value', 'Bearerabc123def456'],
  ['the scheme Digest', 'Digest abc123def456'],
  ['the scheme Token', 'Token abc123def456'],
  ['the scheme Negotiate', 'Negotiate abc123def456'],
  ['the scheme ApiKey', 'ApiKey abc123def456'],
  ['the scheme DPoP', 'DPoP abc123def456'],
  ['the stated limit: a long run of lower-case letters alone', 'Bearer abcdefghijklmnopqrstuvwxyz'],
];

for (const [label, text] of NOT_FOUND) {
  test(`PL6825: not found: ${label}`, () => {
    assert.equal(kindsOf(text).length, 0, `${label}: no finding`);
  });
}
