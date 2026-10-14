// PT33.2, PT33.3: effects manifest idempotency field (DAC6)
// The manifest gains "idempotency" when declared, is absent when not declared
// Three broken lowerings are caught by translation validation with PL2501
// The rule is computed from the read-back manifest (PT33.3), not from AST
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, basename } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { translationValidate, checkMachine } from '@poly/ref';
import { DELIBERATELY_BROKEN_LOWERINGS, FAULT_SOURCES } from './toolchain-faults.mjs';
import { ROOT, build } from './helpers.mjs';

/** Wrap build() to handle the case where the idempotent clause is not yet accepted. */
function buildWithIdempotentSupport(file, name, opts = {}) {
  try {
    return build(file, name, opts);
  } catch (e) {
    if (e.message.includes('idempotent') || e.message.includes('Unexpected token')) {
      assert.fail(`PT33.1: the idempotent clause is not accepted yet: ${e.message}`);
    }
    throw e;
  }
}

// PT33.2: keyed effect manifest includes idempotency field with header and windowMs
test('PT33.2: keyed effect manifest has idempotency field with header and windowMs', () => {
  const results = buildWithIdempotentSupport('test/fixtures/s526/manifest/keyed.poly', 'tv-good');
  assert.ok(results.length > 0, 'keyed.poly should build');

  for (const b of results) {
    const manifestPath = join(b.dir, 'effects.manifest.json');
    assert.ok(existsSync(manifestPath), 'manifest file should exist');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const workEffect = manifest.effects['s526.work'];

    assert.ok(workEffect, 's526.work effect should exist in manifest');
    assert.ok(workEffect.idempotency, 'PT33.2: keyed effect should have idempotency field');
    assert.equal(workEffect.idempotency.header, 'Idempotency-Key', 'PT33.2: header name should match declaration');
    // 24h = 86400000 ms
    assert.equal(workEffect.idempotency.windowMs, 86400000, 'PT33.2: window 24h should be 86400000 ms');
    assert.ok(!workEffect.idempotency.nature, 'PT33.2: nature field should not exist for keyed effect');
  }
});

// CONTROL: PT33.2 plain effect has no idempotency field when not declared (protects against regressions to idempotency-invented fault)
test('CONTROL: PT33.2: plain effect manifest has no idempotency field when not declared', () => {
  const results = buildWithIdempotentSupport('test/fixtures/s526/manifest/plain.poly', 'tv-good');
  assert.ok(results.length > 0, 'plain.poly should build');

  for (const b of results) {
    const manifestPath = join(b.dir, 'effects.manifest.json');
    assert.ok(existsSync(manifestPath), 'manifest file should exist');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const workEffect = manifest.effects['s526.work'];

    assert.ok(workEffect, 's526.work effect should exist in manifest');
    assert.ok(!workEffect.idempotency, 'PT33.2: effect with attempts 1 should have no idempotency field');
  }
});

// PT33.2: nature-idempotent effect manifest includes idempotency field with nature
test('PT33.2: nature-idempotent effect manifest has idempotency field with nature', () => {
  const results = buildWithIdempotentSupport('test/fixtures/s526/manifest/nature.poly', 'tv-good');
  assert.ok(results.length > 0, 'nature.poly should build');

  for (const b of results) {
    const manifestPath = join(b.dir, 'effects.manifest.json');
    assert.ok(existsSync(manifestPath), 'manifest file should exist');

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const workEffect = manifest.effects['s526.work'];

    assert.ok(workEffect, 's526.work effect should exist in manifest');
    assert.ok(workEffect.idempotency, 'PT33.2: nature effect should have idempotency field');
    assert.equal(workEffect.idempotency.nature, 'RFC 7009', 'PT33.2: nature value should match declaration');
    assert.ok(!workEffect.idempotency.header, 'PT33.2: header field should not exist for nature effect');
    assert.ok(!workEffect.idempotency.windowMs, 'PT33.2: windowMs field should not exist for nature effect');
  }
});

// PT33.2: broken lowering idempotency-dropped is caught by translation validation
test('PT33.2: broken lowering idempotency-dropped is caught with PL2501', async (t) => {
  const fault = 'idempotency-dropped';
  const listed = FAULT_SOURCES[fault].map((p) => join(ROOT, p));

  for (const file of listed) {
    const good = buildWithIdempotentSupport(file, 'tv-good');
    const bad = buildWithIdempotentSupport(file, `tv-${fault}`, { fault });

    for (const [k, b] of bad.entries()) {
      // Verify the manifest actually differs between good and bad builds
      const goodManifest = JSON.parse(readFileSync(join(good[k].dir, 'effects.manifest.json'), 'utf8'));
      const badManifest = JSON.parse(readFileSync(join(b.dir, 'effects.manifest.json'), 'utf8'));
      const goodWork = goodManifest.effects['s526.work'];
      const badWork = badManifest.effects['s526.work'];
      assert.notDeepEqual(goodWork, badWork, `PT33.2: ${fault} must change the manifest`);

      const r = await translationValidate(b.module, b.machine, b.dir, { program: b.program, std: b.std, sourceDir: b.sourceDir });

      assert.ok(r.mismatches.length > 0, `PT33.2: ${fault} must be caught by translation validation`);
      assert.ok(r.mismatches.every((d) => d.code === 'PL2501'), `PT33.2: ${fault} should be caught only with PL2501`);
    }
  }
});

// PT33.2: broken lowering idempotency-window-widened is caught by translation validation
test('PT33.2: broken lowering idempotency-window-widened is caught with PL2501', async (t) => {
  const fault = 'idempotency-window-widened';
  const listed = FAULT_SOURCES[fault].map((p) => join(ROOT, p));

  for (const file of listed) {
    const good = buildWithIdempotentSupport(file, 'tv-good');
    const bad = buildWithIdempotentSupport(file, `tv-${fault}`, { fault });

    for (const [k, b] of bad.entries()) {
      // Verify the manifest actually differs between good and bad builds
      const goodManifest = JSON.parse(readFileSync(join(good[k].dir, 'effects.manifest.json'), 'utf8'));
      const badManifest = JSON.parse(readFileSync(join(b.dir, 'effects.manifest.json'), 'utf8'));
      const goodWork = goodManifest.effects['s526.work'];
      const badWork = badManifest.effects['s526.work'];
      assert.notDeepEqual(goodWork, badWork, `PT33.2: ${fault} must change the manifest`);

      const r = await translationValidate(b.module, b.machine, b.dir, { program: b.program, std: b.std, sourceDir: b.sourceDir });

      assert.ok(r.mismatches.length > 0, `PT33.2: ${fault} must be caught by translation validation`);
      assert.ok(r.mismatches.every((d) => d.code === 'PL2501'), `PT33.2: ${fault} should be caught only with PL2501`);
    }
  }
});

// PT33.2: broken lowering idempotency-invented is caught by translation validation
test('PT33.2: broken lowering idempotency-invented is caught with PL2501', async (t) => {
  const fault = 'idempotency-invented';
  const listed = FAULT_SOURCES[fault].map((p) => join(ROOT, p));

  for (const file of listed) {
    const good = buildWithIdempotentSupport(file, 'tv-good');
    const bad = buildWithIdempotentSupport(file, `tv-${fault}`, { fault });

    for (const [k, b] of bad.entries()) {
      // Verify the manifest actually differs between good and bad builds
      const goodManifest = JSON.parse(readFileSync(join(good[k].dir, 'effects.manifest.json'), 'utf8'));
      const badManifest = JSON.parse(readFileSync(join(b.dir, 'effects.manifest.json'), 'utf8'));
      const goodWork = goodManifest.effects['s526.work'];
      const badWork = badManifest.effects['s526.work'];
      assert.notDeepEqual(goodWork, badWork, `PT33.2: ${fault} must change the manifest`);

      const r = await translationValidate(b.module, b.machine, b.dir, { program: b.program, std: b.std, sourceDir: b.sourceDir });

      assert.ok(r.mismatches.length > 0, `PT33.2: ${fault} must be caught by translation validation`);
      assert.ok(r.mismatches.every((d) => d.code === 'PL2501'), `PT33.2: ${fault} should be caught only with PL2501`);
    }
  }
});

// PT33.3: the rule is computed from the read-back manifest, not from the AST
// Test part 1: PL2501 on edited manifest (idempotency field stripped from keyed effect)
test('PT33.3: rule from manifest detects missing idempotency (PL2501)', async (t) => {
  try {
    var results = buildWithIdempotentSupport('test/fixtures/s526/manifest/keyed.poly', 's526-manifest-edited');
  } catch (e) {
    if (e.message.includes('PT33.1')) {
      assert.fail('PT33.1: the idempotent clause is not accepted yet, so keyed.poly cannot be built: ' + e.message);
    }
    throw e;
  }

  // Strip idempotency field from the manifest to simulate a broken lowering
  for (const b of results) {
    const manifestPath = join(b.dir, 'effects.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    delete manifest.effects['s526.work'].idempotency;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  // Translation validation should catch this as a mismatch
  for (const b of results) {
    const r = await translationValidate(b.module, b.machine, b.dir, { program: b.program, std: b.std, sourceDir: b.sourceDir });
    assert.ok(r.mismatches.length > 0, 'PT33.3: edited manifest (idempotency removed) must be caught');
    assert.ok(r.mismatches.some((d) => d.code === 'PL2501' && d.message.includes('idempotency')), 'PT33.3: mismatch must be PL2501 about idempotency');
  }
});

// PT33.3, the part not testable here: poly-ref exposes no public entry that reports rule findings from an edited manifest,
// so 'PL4003 is computed from the manifest' is covered by the load tests (s526-load-worker: load re-derives PS23.5 from the
// manifest it loads) and the rule tests (s526-rule). Reported to the lead as a gap of the unit level, not stubbed.

// CONTROL: verify that the three fault names are registered and have source files
test('CONTROL: idempotency fault names are listed and have sources', () => {
  const faultNames = ['idempotency-dropped', 'idempotency-window-widened', 'idempotency-invented'];

  for (const fault of faultNames) {
    assert.ok(
      DELIBERATELY_BROKEN_LOWERINGS.includes(fault),
      `${fault} should be in DELIBERATELY_BROKEN_LOWERINGS`
    );
    assert.ok(
      FAULT_SOURCES[fault],
      `${fault} should have FAULT_SOURCES entry`
    );
    assert.ok(
      FAULT_SOURCES[fault].length > 0,
      `${fault} should have at least one source file`
    );

    for (const sourceFile of FAULT_SOURCES[fault]) {
      const fullPath = join(ROOT, sourceFile);
      assert.ok(
        existsSync(fullPath),
        `source file ${sourceFile} for ${fault} should exist`
      );

      const content = readFileSync(fullPath, 'utf8');
      // For idempotency-invented, the source deliberately does NOT declare idempotent
      // (the fault invents the field despite its absence in the source).
      // For the other faults, the source must contain idempotent in non-comment lines.
      if (fault === 'idempotency-invented') {
        // idempotency-invented: source has no idempotent clause
        const lines = content.split('\n').filter((line) => !line.trim().startsWith('//'));
        assert.ok(
          !lines.some((line) => /\bidempotent\b/.test(line)),
          `source file ${sourceFile} for ${fault} should NOT contain idempotent keyword outside comments`
        );
      } else {
        assert.ok(
          /\bidempotent\b/.test(content),
          `source file ${sourceFile} for ${fault} should contain idempotent keyword`
        );
      }
    }
  }
});
