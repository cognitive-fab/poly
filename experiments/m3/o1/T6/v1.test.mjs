import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const { default: createHost } = await import(pathToFileURL(process.env.M3_IMPL).href);

// ---------- helpers (test-side only) ----------

function must(r) {
  assert.equal(r.ok, true);
}

async function expectJob(h, id, status, tries, maxTries) {
  const v = await h.job(id);
  assert.notEqual(v, null);
  assert.equal(v.status, status);
  assert.equal(v.tries, tries);
  assert.equal(v.maxTries, maxTries);
}

async function snap(h, ids) {
  const out = [];
  for (const id of ids) {
    const v = await h.job(id);
    out.push(v === null ? null : { status: v.status, tries: v.tries, maxTries: v.maxTries });
  }
  return out;
}

async function refusedNoChange(h, ids, call) {
  const before = await snap(h, ids);
  const r = await call();
  assert.equal(r.ok, false);
  assert.deepEqual(await snap(h, ids), before);
}

// Bring job `id` into `state` through the interface. maxTries defaults to 2
// except for 'failed', which uses 1 unless told otherwise.
async function reach(h, id, state, maxTries) {
  const m = maxTries ?? (state === 'failed' ? 1 : 2);
  must(await h.submit(id, m));
  switch (state) {
    case 'queued':
      return;
    case 'running':
      must(await h.claim(id));
      return;
    case 'cancelling':
      must(await h.claim(id));
      must(await h.cancel(id));
      return;
    case 'succeeded':
      must(await h.claim(id));
      must(await h.succeed(id));
      return;
    case 'failed':
      for (let i = 0; i < m; i++) {
        must(await h.claim(id));
        must(await h.fail(id));
      }
      return;
    case 'cancelled':
      must(await h.cancel(id));
      return;
    case 'held':
      must(await h.hold(id));
      return;
    default:
      throw new Error('unknown state ' + state);
  }
}

// ================= base rules (original brief) =================

// ---------- query ----------

test('job returns null on a fresh system', async () => {
  const h = await createHost();
  assert.equal(await h.job('a'), null);
});

test('job returns null for an id never submitted while others exist', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  assert.equal(await h.job('b'), null);
});

// ---------- submit ----------

for (const m of [1, 2, 3]) {
  test(`submit with maxTries ${m} creates a queued job with 0 tries and maxTries ${m}`, async () => {
    const h = await createHost();
    const r = await h.submit('a', m);
    assert.equal(r.ok, true);
    await expectJob(h, 'a', 'queued', 0, m);
  });
}

for (const m of [0, 4, -1]) {
  test(`submit with maxTries ${m} (outside 1 to 3) is refused and creates no job`, async () => {
    const h = await createHost();
    const r = await h.submit('a', m);
    assert.equal(r.ok, false);
    assert.equal(await h.job('a'), null);
  });
}

test('submit after a refused out-of-range submit of the same id succeeds', async () => {
  const h = await createHost();
  assert.equal((await h.submit('a', 4)).ok, false);
  must(await h.submit('a', 3));
  await expectJob(h, 'a', 'queued', 0, 3);
});

test('submit of an existing id is refused and keeps the original limit', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  await refusedNoChange(h, ['a'], () => h.submit('a', 3));
  await expectJob(h, 'a', 'queued', 0, 2);
});

test('submit of an existing id with the same limit is refused', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  await refusedNoChange(h, ['a'], () => h.submit('a', 2));
});

for (const s of ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled']) {
  test(`submit is refused for an id whose job is ${s}, and nothing changes`, async () => {
    const h = await createHost();
    await reach(h, 'a', s);
    await refusedNoChange(h, ['a'], () => h.submit('a', 3));
  });
}

test('submit of different ids creates independent jobs', async () => {
  const h = await createHost();
  must(await h.submit('a', 1));
  must(await h.submit('b', 3));
  await expectJob(h, 'a', 'queued', 0, 1);
  await expectJob(h, 'b', 'queued', 0, 3);
});

// ---------- commands on unknown ids ----------

for (const cmd of ['claim', 'succeed', 'fail', 'lost', 'cancel']) {
  test(`${cmd} on an id never submitted is refused and creates no job`, async () => {
    const h = await createHost();
    const r = await h[cmd]('ghost');
    assert.equal(r.ok, false);
    assert.equal(await h.job('ghost'), null);
  });

  test(`${cmd} on an id never submitted leaves other jobs unchanged`, async () => {
    const h = await createHost();
    await reach(h, 'a', 'running');
    await refusedNoChange(h, ['a', 'ghost'], () => h[cmd]('ghost'));
  });
}

// ---------- claim ----------

test('claim makes a queued job running and counts one try', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  const r = await h.claim('a');
  assert.equal(r.ok, true);
  await expectJob(h, 'a', 'running', 1, 2);
});

test('claim of a job queued again after a failed try counts a second try', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  must(await h.claim('a'));
  must(await h.fail('a'));
  must(await h.claim('a'));
  await expectJob(h, 'a', 'running', 2, 3);
});

for (const s of ['running', 'cancelling', 'succeeded', 'failed', 'cancelled']) {
  test(`claim is refused for a ${s} job and changes nothing`, async () => {
    const h = await createHost();
    await reach(h, 'a', s);
    await refusedNoChange(h, ['a'], () => h.claim('a'));
  });
}

test('claim of a running job does not count another try', async () => {
  const h = await createHost();
  await reach(h, 'a', 'running', 3);
  assert.equal((await h.claim('a')).ok, false);
  await expectJob(h, 'a', 'running', 1, 3);
});

// ---------- succeed ----------

test('succeed makes a running job succeeded and keeps its tries', async () => {
  const h = await createHost();
  await reach(h, 'a', 'running', 3);
  const r = await h.succeed('a');
  assert.equal(r.ok, true);
  await expectJob(h, 'a', 'succeeded', 1, 3);
});

test('succeed on a later try keeps the count of tries', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  must(await h.claim('a'));
  must(await h.fail('a'));
  must(await h.claim('a'));
  must(await h.lost('a'));
  must(await h.claim('a'));
  must(await h.succeed('a'));
  await expectJob(h, 'a', 'succeeded', 3, 3);
});

test('succeed makes a cancelling job succeeded', async () => {
  const h = await createHost();
  await reach(h, 'a', 'cancelling', 2);
  const r = await h.succeed('a');
  assert.equal(r.ok, true);
  await expectJob(h, 'a', 'succeeded', 1, 2);
});

for (const s of ['queued', 'succeeded', 'failed', 'cancelled']) {
  test(`succeed is refused for a ${s} job and changes nothing`, async () => {
    const h = await createHost();
    await reach(h, 'a', s);
    await refusedNoChange(h, ['a'], () => h.succeed('a'));
  });
}

test('succeed is refused for a job queued again after a failed try', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  must(await h.claim('a'));
  must(await h.fail('a'));
  await refusedNoChange(h, ['a'], () => h.succeed('a'));
});

// ---------- fail and lost (lost is treated exactly as fail) ----------

for (const cmd of ['fail', 'lost']) {
  test(`${cmd} on a running job with tries left makes it queued again`, async () => {
    const h = await createHost();
    await reach(h, 'a', 'running', 2);
    const r = await h[cmd]('a');
    assert.equal(r.ok, true);
    await expectJob(h, 'a', 'queued', 1, 2);
  });

  test(`${cmd} on a running job with maxTries 1 makes it failed`, async () => {
    const h = await createHost();
    await reach(h, 'a', 'running', 1);
    const r = await h[cmd]('a');
    assert.equal(r.ok, true);
    await expectJob(h, 'a', 'failed', 1, 1);
  });

  test(`${cmd} on the second of two tries makes the job failed`, async () => {
    const h = await createHost();
    must(await h.submit('a', 2));
    must(await h.claim('a'));
    must(await h[cmd]('a'));
    must(await h.claim('a'));
    must(await h[cmd]('a'));
    await expectJob(h, 'a', 'failed', 2, 2);
  });

  test(`${cmd} with maxTries 3 requeues after tries 1 and 2 and fails after try 3`, async () => {
    const h = await createHost();
    must(await h.submit('a', 3));
    must(await h.claim('a'));
    must(await h[cmd]('a'));
    await expectJob(h, 'a', 'queued', 1, 3);
    must(await h.claim('a'));
    must(await h[cmd]('a'));
    await expectJob(h, 'a', 'queued', 2, 3);
    must(await h.claim('a'));
    must(await h[cmd]('a'));
    await expectJob(h, 'a', 'failed', 3, 3);
  });

  test(`${cmd} on a cancelling job with tries left makes it cancelled`, async () => {
    const h = await createHost();
    await reach(h, 'a', 'cancelling', 3);
    const r = await h[cmd]('a');
    assert.equal(r.ok, true);
    await expectJob(h, 'a', 'cancelled', 1, 3);
  });

  test(`${cmd} on a cancelling job on its last try makes it cancelled, not failed`, async () => {
    const h = await createHost();
    await reach(h, 'a', 'cancelling', 1);
    const r = await h[cmd]('a');
    assert.equal(r.ok, true);
    await expectJob(h, 'a', 'cancelled', 1, 1);
  });

  for (const s of ['queued', 'succeeded', 'failed', 'cancelled']) {
    test(`${cmd} is refused for a ${s} job and changes nothing`, async () => {
      const h = await createHost();
      await reach(h, 'a', s);
      await refusedNoChange(h, ['a'], () => h[cmd]('a'));
    });
  }

  test(`${cmd} twice in a row is refused the second time`, async () => {
    const h = await createHost();
    await reach(h, 'a', 'running', 3);
    must(await h[cmd]('a'));
    await refusedNoChange(h, ['a'], () => h[cmd]('a'));
    await expectJob(h, 'a', 'queued', 1, 3);
  });
}

test('fail and lost can be mixed across tries and count toward the same limit', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  must(await h.claim('a'));
  must(await h.lost('a'));
  must(await h.claim('a'));
  must(await h.fail('a'));
  await expectJob(h, 'a', 'queued', 2, 3);
  must(await h.claim('a'));
  must(await h.lost('a'));
  await expectJob(h, 'a', 'failed', 3, 3);
});

// ---------- cancel ----------

test('cancel makes a queued job cancelled with no tries', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  const r = await h.cancel('a');
  assert.equal(r.ok, true);
  await expectJob(h, 'a', 'cancelled', 0, 2);
});

test('cancel of a job queued again after a failed try makes it cancelled and keeps its tries', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  must(await h.claim('a'));
  must(await h.fail('a'));
  must(await h.cancel('a'));
  await expectJob(h, 'a', 'cancelled', 1, 3);
});

test('cancel makes a running job cancelling and keeps its tries', async () => {
  const h = await createHost();
  await reach(h, 'a', 'running', 2);
  const r = await h.cancel('a');
  assert.equal(r.ok, true);
  await expectJob(h, 'a', 'cancelling', 1, 2);
});

for (const s of ['cancelling', 'succeeded', 'failed', 'cancelled']) {
  test(`cancel is refused for a ${s} job and changes nothing`, async () => {
    const h = await createHost();
    await reach(h, 'a', s);
    await refusedNoChange(h, ['a'], () => h.cancel('a'));
  });
}

test('cancel is refused for a job cancelled from running by its worker failing', async () => {
  const h = await createHost();
  await reach(h, 'a', 'cancelling', 2);
  must(await h.fail('a'));
  await refusedNoChange(h, ['a'], () => h.cancel('a'));
});

test('cancel is refused for a cancelling job that then succeeded', async () => {
  const h = await createHost();
  await reach(h, 'a', 'cancelling', 2);
  must(await h.succeed('a'));
  await refusedNoChange(h, ['a'], () => h.cancel('a'));
  await expectJob(h, 'a', 'succeeded', 1, 2);
});

test('a cancelled job can no longer be claimed', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  must(await h.cancel('a'));
  await refusedNoChange(h, ['a'], () => h.claim('a'));
});

test('a cancelling job stays cancelling until its worker reports', async () => {
  const h = await createHost();
  await reach(h, 'a', 'cancelling', 3);
  assert.equal((await h.claim('a')).ok, false);
  assert.equal((await h.cancel('a')).ok, false);
  await expectJob(h, 'a', 'cancelling', 1, 3);
});

// ---------- terminal outcomes stay put ----------

for (const s of ['succeeded', 'failed', 'cancelled']) {
  test(`a ${s} job refuses every worker and cancel command and stays ${s}`, async () => {
    const h = await createHost();
    await reach(h, 'a', s);
    const before = await snap(h, ['a']);
    for (const cmd of ['claim', 'succeed', 'fail', 'lost', 'cancel']) {
      assert.equal((await h[cmd]('a')).ok, false);
    }
    assert.deepEqual(await snap(h, ['a']), before);
    assert.equal(before[0].status, s);
  });
}

// ---------- conclusion: never tried more than the limit ----------

for (const m of [1, 2, 3]) {
  test(`a job with maxTries ${m} that keeps failing is tried exactly ${m} times and then refuses claim`, async () => {
    const h = await createHost();
    must(await h.submit('a', m));
    for (let i = 1; i <= m; i++) {
      must(await h.claim('a'));
      await expectJob(h, 'a', 'running', i, m);
      must(await h.fail('a'));
    }
    await expectJob(h, 'a', 'failed', m, m);
    await refusedNoChange(h, ['a'], () => h.claim('a'));
  });

  test(`a job with maxTries ${m} that keeps being lost is tried exactly ${m} times`, async () => {
    const h = await createHost();
    must(await h.submit('a', m));
    for (let i = 1; i <= m; i++) {
      must(await h.claim('a'));
      must(await h.lost('a'));
    }
    await expectJob(h, 'a', 'failed', m, m);
    assert.equal((await h.claim('a')).ok, false);
    await expectJob(h, 'a', 'failed', m, m);
  });
}

test('tries never exceed maxTries whatever commands are attempted', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  const cmds = ['claim', 'claim', 'fail', 'claim', 'cancel', 'claim', 'fail', 'claim', 'succeed', 'lost', 'claim'];
  for (const c of cmds) {
    await h[c]('a');
    const v = await h.job('a');
    assert.ok(v.tries <= v.maxTries);
  }
});

// ---------- conclusion: fails only when the last try failed ----------

test('a job with tries left is never failed by fail: it goes back to queued', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  must(await h.claim('a'));
  must(await h.fail('a'));
  const v = await h.job('a');
  assert.notEqual(v.status, 'failed');
  assert.equal(v.status, 'queued');
});

test('a job that succeeds on its last try is succeeded, not failed', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  must(await h.claim('a'));
  must(await h.fail('a'));
  must(await h.claim('a'));
  must(await h.succeed('a'));
  await expectJob(h, 'a', 'succeeded', 2, 2);
});

// ---------- conclusion: cancel never loses finished work ----------

test('cancelled running job whose worker finished ends succeeded', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  must(await h.claim('a'));
  must(await h.cancel('a'));
  must(await h.succeed('a'));
  await expectJob(h, 'a', 'succeeded', 1, 2);
});

test('cancelled running job whose worker failed ends cancelled', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  must(await h.claim('a'));
  must(await h.cancel('a'));
  must(await h.fail('a'));
  await expectJob(h, 'a', 'cancelled', 1, 2);
});

test('cancelled running job whose worker was lost ends cancelled', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  must(await h.claim('a'));
  must(await h.cancel('a'));
  must(await h.lost('a'));
  await expectJob(h, 'a', 'cancelled', 1, 2);
});

test('cancelled running job on its second try whose worker finished ends succeeded', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  must(await h.claim('a'));
  must(await h.fail('a'));
  must(await h.claim('a'));
  must(await h.cancel('a'));
  must(await h.succeed('a'));
  await expectJob(h, 'a', 'succeeded', 2, 3);
});

test('after a cancelling job succeeds, a late fail is refused and the success stands', async () => {
  const h = await createHost();
  await reach(h, 'a', 'cancelling', 2);
  must(await h.succeed('a'));
  await refusedNoChange(h, ['a'], () => h.fail('a'));
  await expectJob(h, 'a', 'succeeded', 1, 2);
});

test('after a cancelling job is cancelled by fail, a late succeed is refused', async () => {
  const h = await createHost();
  await reach(h, 'a', 'cancelling', 2);
  must(await h.fail('a'));
  await refusedNoChange(h, ['a'], () => h.succeed('a'));
  await expectJob(h, 'a', 'cancelled', 1, 2);
});

test('a cancelling job is never requeued by fail even with tries left', async () => {
  const h = await createHost();
  await reach(h, 'a', 'cancelling', 3);
  must(await h.fail('a'));
  assert.equal((await h.claim('a')).ok, false);
  await expectJob(h, 'a', 'cancelled', 1, 3);
});

// ---------- several jobs ----------

test('commands on one job do not change another job', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  must(await h.submit('b', 3));
  must(await h.claim('a'));
  must(await h.fail('a'));
  must(await h.claim('a'));
  must(await h.cancel('a'));
  must(await h.succeed('a'));
  await expectJob(h, 'b', 'queued', 0, 3);
});

test('interleaved jobs each keep their own tries and outcome', async () => {
  const h = await createHost();
  must(await h.submit('a', 1));
  must(await h.submit('b', 2));
  must(await h.submit('c', 3));
  must(await h.claim('a'));
  must(await h.claim('b'));
  must(await h.claim('c'));
  must(await h.fail('b'));
  must(await h.fail('a'));
  must(await h.cancel('c'));
  must(await h.claim('b'));
  must(await h.succeed('c'));
  must(await h.lost('b'));
  await expectJob(h, 'a', 'failed', 1, 1);
  await expectJob(h, 'b', 'failed', 2, 2);
  await expectJob(h, 'c', 'succeeded', 1, 3);
});

test('a refused command on one job leaves the other jobs unchanged', async () => {
  const h = await createHost();
  await reach(h, 'a', 'running', 2);
  await reach(h, 'b', 'cancelling', 2);
  await reach(h, 'c', 'succeeded', 2);
  await refusedNoChange(h, ['a', 'b', 'c'], () => h.claim('c'));
  await refusedNoChange(h, ['a', 'b', 'c'], () => h.cancel('b'));
  await refusedNoChange(h, ['a', 'b', 'c'], () => h.submit('a', 1));
});

test('job ids are distinct strings: a similar id is a different job', async () => {
  const h = await createHost();
  must(await h.submit('job-1', 2));
  assert.equal(await h.job('job-10'), null);
  assert.equal((await h.claim('job-10')).ok, false);
  await expectJob(h, 'job-1', 'queued', 0, 2);
});

// ================= change 1: hold a queued job =================

for (const cmd of ['hold', 'release']) {
  test(`${cmd} on an id never submitted is refused and creates no job`, async () => {
    const h = await createHost();
    const r = await h[cmd]('ghost');
    assert.equal(r.ok, false);
    assert.equal(await h.job('ghost'), null);
  });

  test(`${cmd} on an id never submitted leaves other jobs unchanged`, async () => {
    const h = await createHost();
    await reach(h, 'a', 'held');
    await reach(h, 'b', 'queued');
    await refusedNoChange(h, ['a', 'b', 'ghost'], () => h[cmd]('ghost'));
  });
}

// ---------- hold ----------

test('hold makes a queued job held with its tries and limit kept', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  const r = await h.hold('a');
  assert.equal(r.ok, true);
  await expectJob(h, 'a', 'held', 0, 3);
});

test('hold of a job queued again after a failed try keeps its tries', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  must(await h.claim('a'));
  must(await h.fail('a'));
  must(await h.hold('a'));
  await expectJob(h, 'a', 'held', 1, 3);
});

for (const s of ['running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'held']) {
  test(`hold is refused for a ${s} job and changes nothing`, async () => {
    const h = await createHost();
    await reach(h, 'a', s);
    await refusedNoChange(h, ['a'], () => h.hold('a'));
  });
}

// ---------- release ----------

test('release makes a held job queued with its tries and limit kept', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  must(await h.hold('a'));
  const r = await h.release('a');
  assert.equal(r.ok, true);
  await expectJob(h, 'a', 'queued', 0, 2);
});

test('release of a held job that had a failed try keeps that try', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  must(await h.claim('a'));
  must(await h.lost('a'));
  must(await h.hold('a'));
  must(await h.release('a'));
  await expectJob(h, 'a', 'queued', 1, 3);
});

for (const s of ['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled']) {
  test(`release is refused for a ${s} job and changes nothing`, async () => {
    const h = await createHost();
    await reach(h, 'a', s);
    await refusedNoChange(h, ['a'], () => h.release('a'));
  });
}

test('release twice is refused the second time', async () => {
  const h = await createHost();
  await reach(h, 'a', 'held');
  must(await h.release('a'));
  await refusedNoChange(h, ['a'], () => h.release('a'));
  await expectJob(h, 'a', 'queued', 0, 2);
});

// ---------- other commands on a held job ----------

test('claim is refused for a held job and counts no try', async () => {
  const h = await createHost();
  await reach(h, 'a', 'held', 2);
  await refusedNoChange(h, ['a'], () => h.claim('a'));
  await expectJob(h, 'a', 'held', 0, 2);
});

for (const cmd of ['succeed', 'fail', 'lost']) {
  test(`${cmd} is refused for a held job and changes nothing`, async () => {
    const h = await createHost();
    await reach(h, 'a', 'held');
    await refusedNoChange(h, ['a'], () => h[cmd]('a'));
  });
}

test('submit is refused for an id whose job is held, and nothing changes', async () => {
  const h = await createHost();
  await reach(h, 'a', 'held');
  await refusedNoChange(h, ['a'], () => h.submit('a', 3));
});

test('cancel makes a held job cancelled', async () => {
  const h = await createHost();
  await reach(h, 'a', 'held', 2);
  const r = await h.cancel('a');
  assert.equal(r.ok, true);
  await expectJob(h, 'a', 'cancelled', 0, 2);
});

test('cancel of a held job that had a failed try keeps its tries', async () => {
  const h = await createHost();
  must(await h.submit('a', 3));
  must(await h.claim('a'));
  must(await h.fail('a'));
  must(await h.hold('a'));
  must(await h.cancel('a'));
  await expectJob(h, 'a', 'cancelled', 1, 3);
});

test('a held job that was cancelled cannot be released or claimed', async () => {
  const h = await createHost();
  await reach(h, 'a', 'held');
  must(await h.cancel('a'));
  await refusedNoChange(h, ['a'], () => h.release('a'));
  await refusedNoChange(h, ['a'], () => h.claim('a'));
  await expectJob(h, 'a', 'cancelled', 0, 2);
});

// ---------- hold in sequences ----------

test('a released job can be claimed and counts one try', async () => {
  const h = await createHost();
  await reach(h, 'a', 'held', 2);
  must(await h.release('a'));
  must(await h.claim('a'));
  await expectJob(h, 'a', 'running', 1, 2);
});

test('repeated hold and release cycles count no tries', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  for (let i = 0; i < 3; i++) {
    must(await h.hold('a'));
    must(await h.release('a'));
  }
  await expectJob(h, 'a', 'queued', 0, 2);
});

test('hold between retries does not change the limit: the job still fails after its last try', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  must(await h.claim('a'));
  must(await h.fail('a'));
  must(await h.hold('a'));
  must(await h.release('a'));
  must(await h.claim('a'));
  must(await h.fail('a'));
  await expectJob(h, 'a', 'failed', 2, 2);
  assert.equal((await h.claim('a')).ok, false);
});

test('a running job cannot be held, and cancel still waits for its worker', async () => {
  const h = await createHost();
  await reach(h, 'a', 'running', 2);
  assert.equal((await h.hold('a')).ok, false);
  must(await h.cancel('a'));
  assert.equal((await h.hold('a')).ok, false);
  must(await h.succeed('a'));
  await expectJob(h, 'a', 'succeeded', 1, 2);
});

test('holding one job does not change another queued job', async () => {
  const h = await createHost();
  must(await h.submit('a', 2));
  must(await h.submit('b', 2));
  must(await h.hold('a'));
  await expectJob(h, 'b', 'queued', 0, 2);
  must(await h.claim('b'));
  await expectJob(h, 'a', 'held', 0, 2);
  await expectJob(h, 'b', 'running', 1, 2);
});

test('a held job refuses all worker commands until released', async () => {
  const h = await createHost();
  await reach(h, 'a', 'held', 3);
  for (const cmd of ['claim', 'succeed', 'fail', 'lost', 'hold']) {
    assert.equal((await h[cmd]('a')).ok, false);
  }
  await expectJob(h, 'a', 'held', 0, 3);
  must(await h.release('a'));
  must(await h.claim('a'));
  must(await h.succeed('a'));
  await expectJob(h, 'a', 'succeeded', 1, 3);
});

