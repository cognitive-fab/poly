// DAC7: impact of the retry-safety rule on existing programs
// (a) scan-retry-safe.mjs reports no unguarded irreversible effects (except orders.poly)
// (b) verdicts file exists and has reasons for changed verdicts
// (c) orders.poly has expected finding line
// (d) standard library effects have retry/idempotent declarations
// (e) test fixtures match library declarations
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, polyFiles } from './helpers.mjs';
import { checkFile } from '@poly/check';

// DAC7(a): run scan-retry-safe.mjs and check section 4 table
test('DAC7(a): scan-retry-safe.mjs section 4: only orders.poly has own unguarded effects', async (t) => {
  const result = spawnSync(process.execPath, ['scripts/scan-retry-safe.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `scan-retry-safe.mjs failed: ${result.stderr}`);

  const lines = result.stdout.split(/\r?\n/);
  const section4Index = lines.findIndex((l) => l.includes('## 4'));

  if (section4Index === -1) {
    assert.fail('scan-retry-safe.mjs should output section 4');
  }

  // Find table start (has "| Program |")
  let tableStart = section4Index + 1;
  while (tableStart < lines.length && !lines[tableStart].includes('| Program |')) {
    tableStart++;
  }

  if (tableStart >= lines.length) {
    assert.fail('scan-retry-safe.mjs section 4 should have a table with Program column');
  }

  // Parse header to find Own and Pulled in columns
  const headerLine = lines[tableStart];
  const headers = headerLine.split('|').map((h) => h.trim()).filter((h) => h);
  const ownIndex = headers.indexOf('Own');
  const pulledInIndex = headers.indexOf('Pulled in');

  if (ownIndex === -1) {
    assert.fail('scan-retry-safe.mjs section 4 table should have Own column');
  }
  if (pulledInIndex === -1) {
    assert.fail('scan-retry-safe.mjs section 4 table should have Pulled in column');
  }

  // Parse table rows (skip header and separator)
  const dataRows = [];
  for (let i = tableStart + 2; i < lines.length; i++) {
    const line = lines[i];

    // Stop at next section
    if (line.startsWith('##')) break;
    if (!line.includes('|')) break;

    const cells = line.split('|').map((c) => c.trim()).filter((c) => c);
    if (cells.length <= 1) break;

    dataRows.push({
      program: cells[0],
      expectedLine: cells[1],
      own: cells[ownIndex],
      pulledIn: cells[pulledInIndex],
    });
  }

  // Assert at least one data row was parsed
  assert.ok(dataRows.length > 0, 'DAC7(a): at least one data row should be parsed from section 4 table');

  // Find the orders.poly row
  const ordersRow = dataRows.find((r) => r.program.includes('examples/orders/orders.poly'));
  assert.ok(ordersRow, 'DAC7(a): examples/orders/orders.poly row should be present in section 4 table');

  // Check that orders.poly has Own >= 1
  const ordersOwnValue = ordersRow.own ? ordersRow.own.split(/\s+/)[0] : '0';
  const ordersOwn = parseInt(ordersOwnValue, 10);
  assert.ok(ordersOwn >= 1, `DAC7(a): examples/orders/orders.poly should have Own >= 1, got ${ordersRow.own}`);

  // Collect offending rows (Own >= 1 or Pulled in >= 1 or classless marker, excluding orders.poly)
  const offendingRows = [];
  for (const row of dataRows) {
    if (row.program.includes('examples/orders/orders.poly')) continue;

    const own = row.own ? row.own.split(/\s+/)[0] : '0';
    const ownValue = parseInt(own, 10);
    const hasClassless = row.own && row.own.includes('classless');
    const pulledIn = row.pulledIn ? row.pulledIn.split(/\s+/)[0] : '0';
    const pulledInValue = parseInt(pulledIn, 10);

    if (ownValue >= 1 || pulledInValue >= 1 || hasClassless) {
      offendingRows.push(row);
    }
  }

  // Fail if any offending rows found (cap at 15 rows plus count)
  if (offendingRows.length > 0) {
    const rowsToShow = offendingRows.slice(0, 15);
    const rowLines = rowsToShow.map((r) => `${r.program} (Own: ${r.own}, Pulled in: ${r.pulledIn})`).join('\n  ');
    const extra = offendingRows.length > 15 ? `\n  ... and ${offendingRows.length - 15} more rows` : '';
    assert.fail(`DAC7(a): offending rows (Own >= 1 or Pulled in >= 1 or classless marker) found:\n  ${rowLines}${extra}`);
  }

  t.diagnostic(`scan-retry-safe.mjs section 4: parsed ${dataRows.length} rows, only orders.poly has unguarded own effects`);
});

// DAC7(b): verdicts file exists, is JSON, and has reasons for changed verdicts
test('DAC7(b): verdicts-after-s526.json exists with reasons for changed verdicts', (t) => {
  const verdictFile = join(ROOT, 'docs', 'demo', 'verdicts-after-s526.json');
  assert.ok(existsSync(verdictFile), 'DAC7(b): docs/demo/verdicts-after-s526.json should exist');

  const afterText = readFileSync(verdictFile, 'utf8');
  let afterVerdicts;
  try {
    afterVerdicts = JSON.parse(afterText);
  } catch (e) {
    assert.fail(`DAC7(b): verdicts-after-s526.json should be valid JSON: ${e.message}`);
  }

  const beforeFile = join(ROOT, 'docs', 'v1', 'verdicts-at-gate-v11.json');
  assert.ok(existsSync(beforeFile), 'DAC7(b): comparison file docs/v1/verdicts-at-gate-v11.json should exist');

  const beforeText = readFileSync(beforeFile, 'utf8');
  const beforeVerdicts = JSON.parse(beforeText);

  // Check that every changed verdict has a reason
  let changedCount = 0;
  for (const [key, after] of Object.entries(afterVerdicts)) {
    const before = beforeVerdicts[key];
    if (before && before.verdict !== after.verdict) {
      assert.ok(after.reason && after.reason.trim().length > 0,
        `DAC7(b): changed verdict for ${key} should have non-empty reason`);
      changedCount++;
      t.diagnostic(`changed: ${key} ${before.verdict} -> ${after.verdict}`);
    }
  }

  assert.ok(changedCount > 0, 'DAC7(b): there should be at least one changed verdict');
});

// DAC7(c): orders.poly has expected finding line and actual findings match
test('CONTROL: DAC7(c): examples/orders/orders.poly first line declares expected findings', (t) => {
  // This test ensures the spec declaration is present: PT33 requires orders.poly to declare
  // its expected findings on the first line as a control line before changing the spec.
  const ordersFile = join(ROOT, 'examples', 'orders', 'orders.poly');
  assert.ok(existsSync(ordersFile), 'examples/orders/orders.poly should exist');

  const text = readFileSync(ordersFile, 'utf8');
  const firstLine = text.split(/\r?\n/)[0];

  assert.equal(firstLine, '// expected: FINDING PL3102 PL4001 PL4002 PL4003',
    'DAC7(c): orders.poly first line should list expected findings including PL4003');
  t.diagnostic('orders.poly first line declares: PL3102 PL4001 PL4002 PL4003');
});

// DAC7(c): verify the actual findings reported by the checker match the expected codes
test('DAC7(c): checkFile reports exactly PL3102, PL4001, PL4002, PL4003 for orders.poly', async (t) => {
  const ordersFile = join(ROOT, 'examples', 'orders', 'orders.poly');
  const outDir = join(ROOT, '.poly', 'test-build', 's526-impact-orders');

  const r = await checkFile(ordersFile, { root: outDir });

  // Extract all codes from the report
  const codes = [...new Set([
    ...r.diagnostics,
    ...r.machines.flatMap((m) => m.diagnostics),
    ...(r.configurations ?? []).flatMap((c) => c.diagnostics),
  ].map((d) => d.code))].sort();

  assert.deepEqual(codes, ['PL3102', 'PL4001', 'PL4002', 'PL4003'],
    `DAC7(c): orders.poly should report exactly PL3102, PL4001, PL4002, PL4003, got ${codes.join(', ')}`);
  t.diagnostic(`checkFile reports findings: ${codes.join(' ')}`);
});

// DAC7(d): standard library declares retry/idempotent on specified effects
test('DAC7(d): standard library channels declare retry { attempts 1 }', (t) => {
  const channels = ['email', 'slack', 'sms', 'whatsapp'];
  const stdDir = join(ROOT, 'std', 'channels');

  for (const channel of channels) {
    const file = join(stdDir, `${channel}.poly`);
    assert.ok(existsSync(file), `DAC7(d): std/channels/${channel}.poly should exist`);

    const text = readFileSync(file, 'utf8');
    // Check that send effect declares retry { attempts 1
    const sendMatch = text.match(/effect\s+send\s*\([^)]*\)\s*{([^}]*)}/);
    assert.ok(sendMatch, `DAC7(d): ${channel}.poly should have send effect`);

    const sendBody = sendMatch[1];
    assert.ok(sendBody.includes('retry { attempts 1'),
      `DAC7(d): ${channel}.poly send effect should declare retry { attempts 1`);
    t.diagnostic(`${channel}.send has retry { attempts 1`);
  }
});

test('DAC7(d): standard library webhook declares retry { attempts 1 }', (t) => {
  const webhookFile = join(ROOT, 'std', 'channels', 'webhook.poly');
  assert.ok(existsSync(webhookFile), 'DAC7(d): std/channels/webhook.poly should exist');

  const text = readFileSync(webhookFile, 'utf8');
  const sendMatch = text.match(/effect\s+send\s*\([^)]*\)\s*{([^}]*)}/);
  assert.ok(sendMatch, 'DAC7(d): webhook.poly should have send effect');

  const sendBody = sendMatch[1];
  assert.ok(sendBody.includes('retry { attempts 1'),
    'DAC7(d): webhook.poly send effect should declare retry { attempts 1');
  t.diagnostic('webhook.send has retry { attempts 1');
});

test('DAC7(d): standard library grant.revoke declares idempotent by nature', (t) => {
  const grantFile = join(ROOT, 'std', 'credentials', 'grant.poly');
  assert.ok(existsSync(grantFile), 'DAC7(d): std/credentials/grant.poly should exist');

  const text = readFileSync(grantFile, 'utf8');
  const revokeMatch = text.match(/effect\s+revoke\s*\([^)]*\)\s*{([^}]*)}/);
  assert.ok(revokeMatch, 'DAC7(d): grant.poly should have revoke effect');

  const revokeBody = revokeMatch[1];
  assert.ok(revokeBody.includes('idempotent by nature'),
    'DAC7(d): grant.poly revoke effect should declare idempotent by nature');
  t.diagnostic('grant.revoke has idempotent by nature');
});

// DAC7(e): test fixtures under std directories match library declarations
test('DAC7(e): test fixtures under std directories match library declarations', (t) => {
  // Helper to find all .poly files named channels-test.poly or grant.poly under a path segment 'std'
  function findStdCopies(startDir) {
    const copies = [];

    function walk(dir) {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (entry.endsWith('.poly')) {
          // Check if this file is named channels-test.poly or grant.poly AND is under a 'std' path segment
          if ((entry === 'channels-test.poly' || entry === 'grant.poly') && fullPath.includes(join('std'))) {
            copies.push(fullPath);
          }
        }
      }
    }

    walk(startDir);
    return copies.sort();
  }

  const fixturesParent = join(ROOT, 'test', 'fixtures');
  const stdCopies = findStdCopies(fixturesParent);

  // Assert the list is non-empty and print in failure message
  assert.ok(stdCopies.length > 0, `DAC7(e): test fixtures should include channels-test.poly or grant.poly copies under std path segments. Found: ${stdCopies.length} files. Searched in ${fixturesParent}`);

  // Track assertions made
  let assertionCount = 0;

  // Check each copy matches library declarations
  for (const copyPath of stdCopies) {
    const text = readFileSync(copyPath, 'utf8');
    const fileName = copyPath.split('\\').pop();

    if (fileName === 'channels-test.poly') {
      // Check for send effect (PS23, K18: test-only std channels must follow the library)
      const sendMatch = text.match(/effect\s+send\s*\([^)]*\)\s*{([^}]*)}/);
      if (!sendMatch) {
        assert.fail(`DAC7(e): fixture ${copyPath} should have a send effect (channels-test.poly copy must follow library)`);
      }

      const sendBody = sendMatch[1];
      assert.ok(sendBody.includes('retry { attempts 1'),
        `DAC7(e): fixture ${copyPath} send effect should declare retry { attempts 1`);
      assertionCount++;
      t.diagnostic(`${copyPath.slice(ROOT.length)} send effect has retry { attempts 1`);
    } else if (fileName === 'grant.poly') {
      // Check for revoke effect
      const revokeMatch = text.match(/effect\s+revoke\s*\([^)]*\)\s*{([^}]*)}/);
      if (!revokeMatch) {
        assert.fail(`DAC7(e): fixture ${copyPath} should have a revoke effect (grant.poly copy must follow library)`);
      }

      const revokeBody = revokeMatch[1];
      assert.ok(revokeBody.includes('idempotent by nature'),
        `DAC7(e): fixture ${copyPath} revoke effect should declare idempotent by nature`);
      assertionCount++;
      t.diagnostic(`${copyPath.slice(ROOT.length)} revoke effect has idempotent by nature`);
    }
  }

  // Assert the count of assertions equals the number of copies
  assert.equal(assertionCount, stdCopies.length,
    `DAC7(e): assertion count (${assertionCount}) should equal number of copies (${stdCopies.length})`);

  t.diagnostic(`DAC7(e): validated ${assertionCount} std copies: ${stdCopies.map(c => c.slice(ROOT.length)).join(', ')}`);
});
