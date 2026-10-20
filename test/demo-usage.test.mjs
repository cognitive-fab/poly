// DF18: a missing usage is an error; single asks check their input limit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProviders, ProviderError } from '../demo/host/live-providers.mjs';
import { describeFailure } from '../demo/host/failures.mjs';

// Helper: create a recording transport that wraps another transport
function recordingTransport(delegate) {
  const records = [];
  return {
    records,
    async request(r) {
      records.push(r);
      return delegate.request(r);
    },
  };
}

// Helper: transport that returns a fixed response with optional usage field
function makeStubTransport(text, usage) {
  return {
    async request() {
      const body = { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
      if (usage !== undefined) {
        body.usage = usage;
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(body),
      };
    },
  };
}

// DF18.1: test bad usage objects for all providers
const badUsages = [
  { input_tokens: null, output_tokens: 20, description: 'null input' },
  { input_tokens: 50, output_tokens: null, description: 'null output' },
  { input_tokens: '', output_tokens: 20, description: 'empty string input' },
  { input_tokens: false, output_tokens: 20, description: 'false input' },
  { input_tokens: [], output_tokens: 20, description: 'array input' },
  { input_tokens: {}, output_tokens: 20, description: 'object input' },
  { input_tokens: '50', output_tokens: 20, description: 'string input' },
  { input_tokens: 50.5, output_tokens: 20, description: 'fraction input' },
  { input_tokens: -1, output_tokens: 20, description: 'negative input' },
  { input_tokens: 50, description: 'missing output' },
  { output_tokens: 20, description: 'missing input' },
  { description: 'both missing' },
];

const providers = [
  { name: 'tiers.small', factory: (p) => p.tiers.small, decision: 'classify', payload: {}, text: '{"answer":"Refund"}' },
  { name: 'tiers.large', factory: (p) => p.tiers.large, decision: 'classify', payload: {}, text: '{"answer":"Refund"}' },
  { name: 'decisions.amount', factory: (p) => p.decisions.amount.provider, decision: 'amount', payload: {}, text: '{"value":450,"cites":["o-9011"]}' },
  { name: 'decisions.answer', factory: (p) => p.decisions.answer.provider, decision: 'answer', payload: {}, text: '{"answer":"Your order is on file.","cites":["o-9011"]}' },
  { name: 'decisions.reply', factory: (p) => p.decisions.reply.provider, decision: 'reply', payload: { outcome: 'Unsure' }, text: '{"answer":"We will follow up."}' },
];

const materials = {
  bodies: { m: 'refund 450 for my order' },
  items: { o: [{ id: 'o-9011', body: 'Order 9011: a desk lamp.' }] },
};

// Test bad usages: each provider with each bad usage should reject with exact message
for (const prov of providers) {
  for (const badUsage of badUsages) {
    // Create usage object for this test (excluding undefined fields)
    const usage = Object.fromEntries(
      Object.entries(badUsage).filter(([k]) => k !== 'description')
    );

    test(`DF18.1: ${prov.name} with ${badUsage.description} rejects "the model provider reported no token usage"`, async () => {
      const t = recordingTransport(makeStubTransport(prov.text, Object.keys(usage).length > 0 ? usage : undefined));
      const providers_inst = makeProviders({
        transport: t,
        apiKey: 'stub-key-for-test',
        models: { small: 'small-model-id', large: 'large-model-id' },
      });

      const provider = prov.factory(providers_inst);
      const question = {
        decision: prov.decision,
        payload: prov.payload,
        intent: 'i',
      };

      await assert.rejects(
        provider(question, materials),
        (e) => {
          assert.ok(e instanceof ProviderError, `should be ProviderError for ${prov.name} ${badUsage.description}`);
          assert.equal(
            e.message,
            'the model provider reported no token usage',
            `wrong message for ${prov.name} ${badUsage.description}`
          );
          return true;
        }
      );
    });
  }
}

// Test good usage: 50 and 20 should pass for each provider
for (const prov of providers) {
  test(`DF18.1: ${prov.name} with good usage (50 and 20) passes`, async () => {
    const t = recordingTransport(makeStubTransport(prov.text, { input_tokens: 50, output_tokens: 20 }));
    const providers_inst = makeProviders({
      transport: t,
      apiKey: 'stub-key-for-test',
      models: { small: 'small-model-id', large: 'large-model-id' },
    });

    const provider = prov.factory(providers_inst);
    const question = {
      decision: prov.decision,
      payload: prov.payload,
      intent: 'i',
    };

    const result = await provider(question, materials);
    assert.ok(result, `${prov.name} should return a result with good usage`);
  });
}

// Test zero usage: 0 and 0 should pass for each provider
for (const prov of providers) {
  test(`DF18.1: ${prov.name} with zero usage (0 and 0) passes`, async () => {
    const t = recordingTransport(makeStubTransport(prov.text, { input_tokens: 0, output_tokens: 0 }));
    const providers_inst = makeProviders({
      transport: t,
      apiKey: 'stub-key-for-test',
      models: { small: 'small-model-id', large: 'large-model-id' },
    });

    const provider = prov.factory(providers_inst);
    const question = {
      decision: prov.decision,
      payload: prov.payload,
      intent: 'i',
    };

    const result = await provider(question, materials);
    assert.ok(result, `${prov.name} should return a result with zero usage`);
  });
}

// DF18.2: test input token limits for answer and reply

// Test answer with 601 tokens over limit of 600
test('DF18.2: answer with 601 input tokens over limit 600 rejects with exact message', async () => {
  const t = recordingTransport(makeStubTransport('{"answer":"Your order is on file.","cites":["o-9011"]}', { input_tokens: 601, output_tokens: 20 }));
  const providers_inst = makeProviders({
    transport: t,
    apiKey: 'stub-key-for-test',
    models: { small: 'small-model-id', large: 'large-model-id' },
  });

  const question = {
    decision: 'answer',
    payload: {},
    intent: 'i',
    limits: { maxInputTokens: 600, maxTokens: 400 },
  };

  await assert.rejects(
    providers_inst.decisions.answer.provider(question, materials),
    (e) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(
        e.message,
        'the message counts 601 tokens, over the declared input limit of 600 (one ask); nothing more was asked'
      );
      return true;
    }
  );
  assert.equal(t.records.length, 1, 'should make exactly one request');
});

// Test answer with 600 tokens at limit (should pass)
test('DF18.2: answer with 600 input tokens at limit 600 passes', async () => {
  const t = recordingTransport(makeStubTransport('{"answer":"Your order is on file.","cites":["o-9011"]}', { input_tokens: 600, output_tokens: 20 }));
  const providers_inst = makeProviders({
    transport: t,
    apiKey: 'stub-key-for-test',
    models: { small: 'small-model-id', large: 'large-model-id' },
  });

  const question = {
    decision: 'answer',
    payload: {},
    intent: 'i',
    limits: { maxInputTokens: 600, maxTokens: 400 },
  };

  const result = await providers_inst.decisions.answer.provider(question, materials);
  assert.ok(result, 'answer should pass with input tokens at limit');
  assert.equal(t.records.length, 1, 'should make exactly one request');
});

// Test reply with 601 tokens over limit of 600
test('DF18.2: reply with 601 input tokens over limit 600 rejects with exact message', async () => {
  const t = recordingTransport(makeStubTransport('{"answer":"We will follow up."}', { input_tokens: 601, output_tokens: 20 }));
  const providers_inst = makeProviders({
    transport: t,
    apiKey: 'stub-key-for-test',
    models: { small: 'small-model-id', large: 'large-model-id' },
  });

  const question = {
    decision: 'reply',
    payload: { outcome: 'Unsure' },
    intent: 'i',
    limits: { maxInputTokens: 600, maxTokens: 400 },
  };

  await assert.rejects(
    providers_inst.decisions.reply.provider(question, materials),
    (e) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(
        e.message,
        'the message counts 601 tokens, over the declared input limit of 600 (one ask); nothing more was asked'
      );
      return true;
    }
  );
  assert.equal(t.records.length, 1, 'should make exactly one request');
});

// Test reply with 600 tokens at limit (should pass)
test('DF18.2: reply with 600 input tokens at limit 600 passes', async () => {
  const t = recordingTransport(makeStubTransport('{"answer":"We will follow up."}', { input_tokens: 600, output_tokens: 20 }));
  const providers_inst = makeProviders({
    transport: t,
    apiKey: 'stub-key-for-test',
    models: { small: 'small-model-id', large: 'large-model-id' },
  });

  const question = {
    decision: 'reply',
    payload: { outcome: 'Unsure' },
    intent: 'i',
    limits: { maxInputTokens: 600, maxTokens: 400 },
  };

  const result = await providers_inst.decisions.reply.provider(question, materials);
  assert.ok(result, 'reply should pass with input tokens at limit');
  assert.equal(t.records.length, 1, 'should make exactly one request');
});

// Test answer with default limit (2000): 2001 should fail, 2000 should pass
test('DF18.2: answer with 2001 input tokens over default limit 2000 rejects with exact message', async () => {
  const t = recordingTransport(makeStubTransport('{"answer":"Your order is on file.","cites":["o-9011"]}', { input_tokens: 2001, output_tokens: 20 }));
  const providers_inst = makeProviders({
    transport: t,
    apiKey: 'stub-key-for-test',
    models: { small: 'small-model-id', large: 'large-model-id' },
  });

  const question = {
    decision: 'answer',
    payload: {},
    intent: 'i',
    // no limits: should use default 2000
  };

  await assert.rejects(
    providers_inst.decisions.answer.provider(question, materials),
    (e) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(
        e.message,
        'the message counts 2001 tokens, over the declared input limit of 2000 (one ask); nothing more was asked'
      );
      return true;
    }
  );
  assert.equal(t.records.length, 1, 'should make exactly one request');
});

// Test answer with default limit (2000): 2000 should pass
test('DF18.2: answer with 2000 input tokens at default limit 2000 passes', async () => {
  const t = recordingTransport(makeStubTransport('{"answer":"Your order is on file.","cites":["o-9011"]}', { input_tokens: 2000, output_tokens: 20 }));
  const providers_inst = makeProviders({
    transport: t,
    apiKey: 'stub-key-for-test',
    models: { small: 'small-model-id', large: 'large-model-id' },
  });

  const question = {
    decision: 'answer',
    payload: {},
    intent: 'i',
    // no limits: should use default 2000
  };

  const result = await providers_inst.decisions.answer.provider(question, materials);
  assert.ok(result, 'answer should pass with input tokens at default limit');
  assert.equal(t.records.length, 1, 'should make exactly one request');
});

// Test reply with default limit (2000): 2001 should fail, 2000 should pass
test('DF18.2: reply with 2001 input tokens over default limit 2000 rejects with exact message', async () => {
  const t = recordingTransport(makeStubTransport('{"answer":"We will follow up."}', { input_tokens: 2001, output_tokens: 20 }));
  const providers_inst = makeProviders({
    transport: t,
    apiKey: 'stub-key-for-test',
    models: { small: 'small-model-id', large: 'large-model-id' },
  });

  const question = {
    decision: 'reply',
    payload: { outcome: 'Unsure' },
    intent: 'i',
    // no limits: should use default 2000
  };

  await assert.rejects(
    providers_inst.decisions.reply.provider(question, materials),
    (e) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(
        e.message,
        'the message counts 2001 tokens, over the declared input limit of 2000 (one ask); nothing more was asked'
      );
      return true;
    }
  );
  assert.equal(t.records.length, 1, 'should make exactly one request');
});

// Test reply with default limit (2000): 2000 should pass
test('DF18.2: reply with 2000 input tokens at default limit 2000 passes', async () => {
  const t = recordingTransport(makeStubTransport('{"answer":"We will follow up."}', { input_tokens: 2000, output_tokens: 20 }));
  const providers_inst = makeProviders({
    transport: t,
    apiKey: 'stub-key-for-test',
    models: { small: 'small-model-id', large: 'large-model-id' },
  });

  const question = {
    decision: 'reply',
    payload: { outcome: 'Unsure' },
    intent: 'i',
    // no limits: should use default 2000
  };

  const result = await providers_inst.decisions.reply.provider(question, materials);
  assert.ok(result, 'reply should pass with input tokens at default limit');
  assert.equal(t.records.length, 1, 'should make exactly one request');
});

// DF18.2: describeFailure tests
test('DF18.2: describeFailure on input limit error gives "over its input share"', async () => {
  const row = {
    kind: 'decision.answer',
    attempts: 1,
    last_error: 'the message counts 601 tokens, over the declared input limit of 600 (one ask); nothing more was asked',
    payload: {},
  };
  const context = { routes: [], secrets: [] };
  const line = describeFailure(row, context);
  assert.match(line, /over its input share/, `should have "over its input share", got: ${line}`);
});

test('DF18.2: describeFailure on vote input limit error gives "over its input share"', async () => {
  const row = {
    kind: 'decision.amount',
    attempts: 1,
    last_error: 'the message counts 51 tokens, over its share of 50 (the declared input limit, 250, over 5 asks); nothing more was asked',
    payload: {},
  };
  const context = { routes: [], secrets: [] };
  const line = describeFailure(row, context);
  assert.match(line, /over its input share/, `should have "over its input share" for vote, got: ${line}`);
});
