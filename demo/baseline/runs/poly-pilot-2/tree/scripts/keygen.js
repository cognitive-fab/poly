// `npm run keygen`: makes the ed25519 admission key pair outside the project (a private key is never committed),
// in ~/.support-agent by default or the directory given, and prints the two variables `admit` and `start` read.
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? join(homedir(), '.support-agent'))
const priv = join(dir, 'admission.pem')
const pub = join(dir, 'admission.pub.pem')
if (existsSync(priv)) {
  console.error(`${priv} exists; not overwritten`)
} else {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  mkdirSync(dir, { recursive: true })
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }))
  console.log(`wrote ${priv} and ${pub}`)
}
console.log(`\nexport POLY_ADMISSION_KEY="$(cat '${priv}')"\nexport POLY_TRUST_KEY='${pub}'`)
