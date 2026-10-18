import { generateKeyPairSync } from 'node:crypto'
import { admit } from '@poly/check'
import { load } from '@poly/runtime'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' })
const pub = publicKey.export({ type: 'spki', format: 'pem' })
const t0 = Date.now()
const a = await admit('.', { key: { id: 'support-admission', privateKeyPem: priv } })
console.log('admit', a.verdict, Date.now() - t0, 'ms', a.certificatePath)
let now = Date.now()
const calls = []
const rt = await load('./.poly/build', {
  certificate: './.poly/certificate.json', trust: { 'support-admission': pub }, now: () => now,
  transports: {
    egress: async (req) => { calls.push(req); return { status: 200, body: JSON.stringify({ id: 're_1', status: 'succeeded', messages: [{ id: 'wamid.1' }] }) } },
    secrets: (n) => 'x-' + n,
    store: { read: (t, k) => t === 'orders' ? { order: 'ORD-1001', customer: '15550100001', charge: 'ch_demo_1001', currency: 'usd', items: [{ sku: 'BLENDER-1', price: 6000 }, { sku: 'CUPS-4', price: 4000 }] } : { phoneNumberId: '123' }, write() {} },
  },
})
rt.handle('stripe.refund', rt.handlerExports('handlers/stripe.js').refund)
rt.handle('whatsapp.notify', rt.handlerExports('handlers/whatsapp.js').notify)
const c = await rt.create('support.Order', { id: 'ORD-1001', creation: { action: 'Open', data: { lines: 2 } } })
console.log('create', JSON.stringify(c))
console.log(JSON.stringify(await rt.dispatch('ORD-1001', 'RequestLine', { line: 1 }, { actionId: 'm1' })))
console.log(JSON.stringify(await rt.dispatch('ORD-1001', 'RequestLine', { line: 1 }, { actionId: 'm1' })))
console.log(JSON.stringify(await rt.dispatch('ORD-1001', 'RequestLine', { line: 1 }, { actionId: 'm2' })))
console.log(JSON.stringify(await rt.dispatch('ORD-1001', 'Confirm', {}, { actionId: 'm4' })))
await rt.advance(5)
console.log(JSON.stringify(await rt.getState('ORD-1001')))
console.log(JSON.stringify(calls, null, 1))
console.log(JSON.stringify(await rt.dispatch('ORD-1001', 'RequestAll', {}, { actionId: 'm5' })))
now += 31 * 60 * 1000
console.log(JSON.stringify(await rt.tick(now)))
console.log(JSON.stringify(await rt.getState('ORD-1001')))
console.log(JSON.stringify(await rt.dispatch('ORD-1001', 'Refunded', {}, { actionId: 'm6' })))
try { await rt.create('support.Order', { id: 'ORD-1001', creation: { action: 'Open', data: { lines: 2 } } }) } catch (e) { console.log('recreate', e.message) }
await rt.close()
