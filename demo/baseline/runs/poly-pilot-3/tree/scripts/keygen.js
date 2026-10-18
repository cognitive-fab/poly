// Generates the ed25519 admission key pair, outside the project (lib/config.js). Run once.
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PRIVATE_KEY_FILE, PUBLIC_KEY_FILE } from '../lib/config.js'

if (existsSync(PRIVATE_KEY_FILE)) {
  console.log(`an admission key already exists at ${PRIVATE_KEY_FILE}; nothing written`)
} else {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  mkdirSync(dirname(PRIVATE_KEY_FILE), { recursive: true })
  mkdirSync(dirname(PUBLIC_KEY_FILE), { recursive: true })
  writeFileSync(PRIVATE_KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  writeFileSync(PUBLIC_KEY_FILE, publicKey.export({ type: 'spki', format: 'pem' }))
  console.log(`wrote ${PRIVATE_KEY_FILE} and ${PUBLIC_KEY_FILE}`)
}
