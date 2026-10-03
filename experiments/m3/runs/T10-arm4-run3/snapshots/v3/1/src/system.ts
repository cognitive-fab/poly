// T10, a lease with fencing tokens: the lease service and its two clients, talking by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, when, send, invariant,
  configuration, instance, forall, implies,
} from '@cognitive-fab/poly/embed';

export default module('fencing', [
  enumType('Status', ['idle', 'requesting', 'holding', 'releasing']),

  // The lease service: grants at most 2 leases (tokens 1 and 2) and takes at most 2 writes.
  // `current` is the last token granted; a message's `token` is the sender's.
  machine('Service', {
    service: true,
    state: {
      holder: field(t.ref('Client'), ($) => $.none),
      current: field(t.range(0, 2), () => 0),
      writes: field(t.range(0, 2), () => 0),
      // Whether a write was taken since the last grant: at most one write per grant.
      wrote: field(t.bool, () => false),
    },
    items: [
      action('Acquire', { from: t.ref('Client') }),
      action('Release', { from: t.ref('Client'), token: t.range(0, 2) }),
      action('Write', { from: t.ref('Client'), token: t.range(0, 2) }),
      action('Expire', {}),
      on('Acquire', ($) => [
        when($.holder === $.none && $.current < 2,
          [set('holder', $.from), set('current', $.current + 1), set('wrote', false), send($.from, 'Granted', { token: $.current + 1 })],
          [send($.from, 'Denied', {})]),
      ], ['from']),
      // A release is always answered, whether the lease is taken back or the release ignored.
      on('Release', ($) => [
        when($.holder !== $.none && $.holder === $.from && $.token === $.current, [set('holder', $.none)]),
        send($.from, 'Released', {}),
      ], ['from', 'token']),
      on('Write', ($) => [
        when($.holder !== $.none && $.holder === $.from && $.token === $.current && !$.wrote && $.writes < 2,
          [set('writes', $.writes + 1), set('wrote', true), send($.from, 'WriteDone', {})],
          [send($.from, 'WriteRefused', {})]),
      ], ['from', 'token']),
      on('Expire', ($) => [
        require($.holder !== $.none, 'no-holder'),
        set('holder', $.none),
        send($.holder, 'Revoked', { token: $.current }),
      ]),
    ],
  }),

  // A client. `mine` is the last token it was granted; `revoked` the newest token revoked while it did not hold.
  machine('Client', {
    service: true,
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      mine: field(t.range(0, 2), () => 0),
      writing: field(t.bool, () => false),
      revoked: field(t.range(0, 2), () => 0),
      lease: field(t.ref('Service'), ($) => $.none),
    },
    items: [
      action('Acquire', {}),
      action('Release', {}),
      action('Write', {}),
      action('Granted', { token: t.range(1, 2) }),
      action('Denied', {}),
      action('Released', {}),
      action('Revoked', { token: t.range(1, 2) }),
      action('WriteDone', {}),
      action('WriteRefused', {}),
      on('Acquire', ($) => [
        require($.status === $.idle, 'not-idle'),
        set('status', $.requesting),
        send($.lease, 'Acquire', { from: $.self }),
      ]),
      on('Release', ($) => [
        require($.status === $.holding, 'not-holding'),
        set('status', $.releasing),
        send($.lease, 'Release', { from: $.self, token: $.mine }),
      ]),
      on('Write', ($) => [
        require($.status === $.holding, 'not-holding'),
        require(!$.writing, 'write-pending'),
        set('writing', true),
        send($.lease, 'Write', { from: $.self, token: $.mine }),
      ]),
      on('CancelAcquire', ($) => [
        require($.status === $.requesting, 'not-requesting'),
        set('status', $.abandoning),
      ]),
      on('Granted', ($) => [
        require($.status === $.requesting || $.status === $.abandoning, 'not-requesting'),
        set('mine', $.token),
        when($.status === $.abandoning,
          // An abandoning client gives the lease straight back, as release does.
          [set('status', $.releasing), send($.lease, 'Release', { from: $.self, token: $.token })],
          [when($.token <= $.revoked, [set('status', $.idle)], [set('status', $.holding)])]),
      ], ['token']),
      on('Denied', ($) => [
        require($.status === $.requesting || $.status === $.abandoning, 'not-requesting'),
        set('status', $.idle),
      ]),
      on('Released', ($) => [
        require($.status === $.releasing, 'not-releasing'),
        set('status', $.idle),
      ]),
      on('Revoked', ($) => [
        require($.status !== $.releasing, 'releasing'),
        when($.status === $.holding,
          [require($.token === $.mine, 'not-my-token'), set('status', $.idle)],
          [require($.token > $.revoked, 'older-revoke'), set('revoked', $.token)]),
      ], ['token']),
      on('WriteDone', ($) => [require($.writing, 'no-write'), set('writing', false)]),
      on('WriteRefused', ($) => [require($.writing, 'no-write'), set('writing', false)]),
    ],
  }),

  configuration('two-clients', {
    instances: [
      instance('lease', 'Service'),
      instance('c', 'Client', { count: 2, init: ($) => ({ lease: $.lease }) }),
    ],
    inputs: ['c[*].Acquire', 'c[*].Release', 'c[*].Write', 'lease.Expire'],
    // Per client one request, release or their answer and one write or its answer, plus at most 2 revokes.
    bounds: { transit: 8 },
    properties: [
      // At most one write per grant.
      invariant('one-write-per-grant', ($) => $.lease.writes <= $.lease.current),
      // At most one client holds the lease with the current token.
      invariant('one-current-holder', ($) => forall('i', 'c', ($) => forall('j', 'c', ($) =>
        implies($.i !== $.j && $.c[$.i].status === $.holding && $.c[$.j].status === $.holding,
          $.c[$.i].mine !== $.lease.current || $.c[$.j].mine !== $.lease.current)))),
    ],
  }),
]);
