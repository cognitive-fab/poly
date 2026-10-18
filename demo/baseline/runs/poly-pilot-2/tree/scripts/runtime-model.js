// Restores the runtime's OutboxIntent model in the installed @poly/runtime, which ships without its model/ folder.
//
// `load` hosts PT9.7's OutboxIntent at each retry bound a build declares, from model/build/runtime<m>.OutboxIntent,
// whose bytes must match model/build/MANIFEST.json. This script takes the model's text from the specification
// (tools/poly/docs/03-technical-spec.md, PT9.7), instantiates it at every bound from 1 to 10 with the runtime's own
// modelSource, and checks and lowers each with poly check. The checker takes a module named runtime<m> only when its
// digest is one of the digests @poly/core pins for the model (PL1208 otherwise), so a text that is not the model is
// refused here rather than run. Runs after `npm install`, and again whenever the folder is missing.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SPEC = join(PROJECT, 'tools', 'poly', 'docs', '03-technical-spec.md')

/** The PT9.7 block of the specification, unindented. */
export function specModelText(spec = readFileSync(SPEC, 'utf8')) {
  const at = spec.indexOf('**PT9.7 The outbox intent is a checked machine.**')
  if (at < 0) throw new Error('PT9.7 is not in the specification')
  const m = spec.slice(at).match(/```poly\r?\n([\s\S]*?)\r?\n\s*```/)
  if (!m) throw new Error('PT9.7 has no poly block')
  return m[1].split(/\r?\n/).map((l) => l.replace(/^ {2}/, '')).join('\n') + '\n'
}

export async function ensureRuntimeModel({ force = false } = {}) {
  const { MODEL_DIR, MODEL_BUILD, MODEL_FILES, BOUNDS, modelSource, machineOfBound, moduleOfBound } = await import('@poly/runtime/model')
  if (!force && existsSync(join(MODEL_BUILD, 'MANIFEST.json'))) return { built: false, dir: MODEL_DIR }
  const { checkFile } = await import('@poly/check')
  const { sha256OfBytes } = await import('@poly/core')
  const text = specModelText()
  const work = mkdtempSync(join(tmpdir(), 'poly-runtime-model-'))
  try {
    const manifest = {}
    const built = join(work, 'build')
    for (const m of BOUNDS) {
      const id = machineOfBound(m)
      const file = join(work, `${moduleOfBound(m)}.poly`)
      writeFileSync(file, modelSource(m, text))
      const r = await checkFile(file, { root: work })
      if (r.verdict !== 'CLEAN') {
        const why = (r.diagnostics ?? []).map((d) => `${d.code} ${d.message}`).join('; ')
        throw new Error(`the OutboxIntent model at bound ${m} is ${r.verdict}${why ? `: ${why}` : ''}`)
      }
      mkdirSync(join(built, id), { recursive: true })
      for (const f of MODEL_FILES) {
        const from = join(work, '.poly', 'build', id, f)
        if (!existsSync(from)) throw new Error(`poly check wrote no ${id}/${f}`)
        cpSync(from, join(built, id, f))
        manifest[`${id}/${f}`] = sha256OfBytes(readFileSync(from))
      }
    }
    writeFileSync(join(built, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n')
    rmSync(MODEL_DIR, { recursive: true, force: true })
    mkdirSync(MODEL_DIR, { recursive: true })
    writeFileSync(join(MODEL_DIR, 'outbox-intent.poly'), text)
    cpSync(built, MODEL_BUILD, { recursive: true })
    return { built: true, dir: MODEL_DIR }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await ensureRuntimeModel({ force: process.argv.includes('--force') })
  console.log(r.built ? `restored the OutboxIntent model in ${r.dir}` : `the OutboxIntent model is in place (${r.dir})`)
}
