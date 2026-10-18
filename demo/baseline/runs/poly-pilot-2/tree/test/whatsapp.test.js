import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handshake, messagesOf, sign, signatureValid } from '../src/whatsapp.js'
import { webhookPayload } from './fixture.js'

test('handshake echoes the challenge only for the right verify token', () => {
  const q = (token) => new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '1158201444' })
  assert.equal(handshake(q('s3cret'), 's3cret'), '1158201444')
  assert.equal(handshake(q('wrong!'), 's3cret'), null)
  assert.equal(handshake(q('s3cret'), undefined), null)
  assert.equal(handshake(new URLSearchParams({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 's3cret' }), 's3cret'), null)
})

test('the payload signature is HMAC-SHA256 of the raw body under the app secret', () => {
  const raw = Buffer.from('{"object":"whatsapp_business_account"}')
  assert.ok(signatureValid(raw, sign(raw, 'app-secret'), 'app-secret'))
  assert.ok(!signatureValid(raw, sign(raw, 'other-secret'), 'app-secret'))
  assert.ok(!signatureValid(Buffer.from(raw.toString() + ' '), sign(raw, 'app-secret'), 'app-secret'))
  assert.ok(!signatureValid(raw, undefined, 'app-secret'))
  assert.ok(!signatureValid(raw, 'sha256=abcd', 'app-secret'))
  assert.ok(!signatureValid(raw, sign(raw, 'app-secret'), ''))
})

test('messagesOf reads text messages and the sender profile, and skips statuses', () => {
  const p = webhookPayload({ id: 'wamid.A', from: '15550100001', text: 'refund ORD-1001', name: 'Ada' })
  assert.deepEqual(messagesOf(p), [{ id: 'wamid.A', from: '15550100001', name: 'Ada', text: 'refund ORD-1001', phoneNumberId: '1234567890' }])
  const statuses = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.out1', status: 'delivered' }] } }] }] }
  assert.deepEqual(messagesOf(statuses), [])
  assert.deepEqual(messagesOf({ object: 'page' }), [])
  const image = webhookPayload({ id: 'wamid.B', from: '1', text: '' })
  image.entry[0].changes[0].value.messages[0] = { from: '1', id: 'wamid.B', type: 'image', image: { id: 'x' } }
  assert.equal(messagesOf(image)[0].text, '')
})
