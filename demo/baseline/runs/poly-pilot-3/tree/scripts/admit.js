// Checks the project (src/*.poly and the handlers) and, when it is CLEAN, writes the signed .poly/certificate.json
// that the runtime loads. Run after every change to src/ or handlers/.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { admit } from '@poly/check'
import { PRIVATE_KEY_FILE } from '../lib/config.js'
import { ADMISSION_KEY_ID } from '../lib/host.js'

const root = fileURLToPath(new URL('..', import.meta.url))
try {
  const r = await admit(root, { key: { id: ADMISSION_KEY_ID, privateKeyPem: readFileSync(PRIVATE_KEY_FILE, 'utf8') } })
  console.log(`admitted: ${r.verdict}, certificate at ${r.certificatePath}`)
} catch (e) {
  console.error(`not admitted: ${e.message}`)
  process.exitCode = 1
}
