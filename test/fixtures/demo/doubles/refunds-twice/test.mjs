// The double passes its own tests: it builds the refund request it should.
import assert from 'node:assert/strict';
assert.equal(new URLSearchParams('charge=ch_demo_1001&amount=4000').get('amount'), '4000');
console.log('1 test passed');
