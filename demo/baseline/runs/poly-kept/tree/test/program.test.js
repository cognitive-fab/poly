// The poly program itself: it checks CLEAN, and the checker catches the double refunds its guards prevent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkFile } from '@poly/check'
import { ROOT } from '../src/runtime.js'

const source = readFileSync(join(ROOT, 'src', 'support.poly'), 'utf8')

/** Checks a variant of the source in a directory of its own, so no build output meets the project's. */
async function check(text) {
  const dir = mkdtempSync(join(tmpdir(), 'support-poly-'))
  const file = join(dir, 'support.poly')
  writeFileSync(file, text)
  return checkFile(file, { root: dir })
}

const codes = (r) => [...r.diagnostics, ...r.machines.flatMap((m) => m.diagnostics)].map((d) => `${d.code} ${d.message ?? ''}`)

test('support.poly checks CLEAN', async () => {
  const r = await check(source)
  assert.equal(r.verdict, 'CLEAN', codes(r).join('\n'))
  const ticket = r.machines.find((m) => m.machine === 'Ticket' || m.id === 'support.Ticket' || String(m.machine).endsWith('Ticket'))
  assert.ok(ticket, 'the Ticket machine is checked')
})

test('without the already-refunded guard, the checker finds a double refund', async () => {
  const mutant = source.replace('    require !refunded[line]     else reject "already-refunded"\n', '')
  assert.notEqual(mutant, source)
  const r = await check(mutant)
  assert.equal(r.verdict, 'FINDINGS')
  assert.ok(codes(r).some((c) => c.startsWith('PL3')), codes(r).join('\n'))
})

test('refunding the whole order again after one item is a finding', async () => {
  const mutant = source.replace('let w1 = 1 < lines && !refunded[1]', 'let w1 = 1 < lines')
  assert.notEqual(mutant, source)
  const r = await check(mutant)
  assert.equal(r.verdict, 'FINDINGS')
})

test('a refund that moves money without confirmation is a finding', async () => {
  const mutant = source.replace(
    '    phase\' = Confirming\n    want\' = [w0, w1, w2, w3]\n    emit say(msg: AskConfirm, l0: w0, l1: w1, l2: w2, l3: w3)',
    '    phase\' = Refunding\n    want\' = [w0, w1, w2, w3]\n    emit refund(l0: w0, l1: w1, l2: w2, l3: w3)',
  )
  assert.notEqual(mutant, source)
  const r = await check(mutant)
  assert.equal(r.verdict, 'FINDINGS')
})
