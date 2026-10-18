import { generateKeyPairSync } from 'node:crypto'
import { admit } from '@poly/check'
import { load } from '@poly/runtime'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
await admit('.', { key: { id: 'support-admission', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) } })
const rt = await load('./.poly/build', { certificate: './.poly/certificate.json', trust: { 'support-admission': publicKey.export({ type: 'spki', format: 'pem' }) } })
try { console.log(await rt.getState('NOPE')) } catch (e) { console.log('getState unknown:', e.constructor.name, e.message) }
await rt.create('support.Order', { id: 'X', creation: { action: 'Open', data: { lines: 2 } } })
await rt.dispatch('X', 'RequestAll', {}, { actionId: 'q' })
try { const b = await rt.create('support.Order', { id: 'X', creation: { action: 'Open', data: { lines: 2 } } }); console.log('recreate ok', JSON.stringify(b)) } catch (e) { console.log('recreate:', e.constructor.name, e.message) }
console.log(JSON.stringify(await rt.instances()))
await rt.close()
