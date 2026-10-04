// T10, a lease with fencing tokens: a lease service and two clients that talk by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, when, send, configuration, instance, invariant, implies,
} from '@cognitive-fab/poly/embed';

export default module('fencing', [
  enumType('Status', ['idle', 'requesting', 'holding']),

  // The lease service: the holder, the last token granted (also the number of grants), the writes taken.
  machine('Lease', {
    service: true,
    state: {
      holder: field(t.ref('Client'), ($) => $.none),
      lastToken: field(t.range(0, 2), () => 0),
      writes: field(t.range(0, 2), () => 0),
    },
    items: [
      action('Acquire', { from: t.ref('Client') }),
      action('Release', { from: t.ref('Client'), token: t.range(0, 2) }),
      action('Write', { from: t.ref('Client'), token: t.range(0, 2) }),
      action('Expire', {}),

      on('Acquire', ($) => [
        when($.holder === $.none && $.lastToken < 2, [
          set('holder', $.from),
          set('lastToken', $.lastToken + 1),
          send($.from, 'Granted', { token: $.lastToken + 1 }),
        ], [
          send($.from, 'Denied', {}),
        ]),
      ]),
      on('Release', ($) => [
        require($.holder !== $.none && $.holder === $.from && $.token === $.lastToken, 'not-the-holder'),
        set('holder', $.none),
      ]),
      on('Write', ($) => [
        when($.holder !== $.none && $.holder === $.from && $.token === $.lastToken && $.writes < 2, [
          set('writes', $.writes + 1),
          send($.from, 'WriteDone', {}),
        ], [
          send($.from, 'WriteRefused', {}),
        ]),
      ]),
      on('Expire', ($) => [
        require($.holder !== $.none, 'no-holder'),
        set('holder', $.none),
        send($.holder, 'Revoked', { token: $.lastToken }),
      ]),

      invariant('holder-was-granted', ($) => implies($.holder !== $.none, $.lastToken > 0)),
    ],
  }),

  // A client: its status, the last token granted to it, whether a write waits for an answer, and the newest
  // token revoked while it did not hold the lease.
  machine('Client', {
    service: true,
    state: {
      status: field(t.named('Status'), ($) => $.Idle),
      held: field(t.range(0, 2), () => 0),
      writing: field(t.bool, () => false),
      revoked: field(t.range(0, 2), () => 0),
      lease: field(t.ref('Lease'), ($) => $.none),
    },
    items: [
      action('RequestLease', {}),
      action('ReleaseLease', {}),
      action('SendWrite', {}),
      action('Granted', { token: t.range(0, 2) }),
      action('Denied', {}),
      action('Revoked', { token: t.range(0, 2) }),
      action('WriteDone', {}),
      action('WriteRefused', {}),

      on('RequestLease', ($) => [
        require($.status === $.Idle, 'not-idle'),
        set('status', $.Requesting),
        send($.lease, 'Acquire', { from: $.self }),
      ]),
      on('ReleaseLease', ($) => [
        require($.status === $.Holding, 'not-holding'),
        set('status', $.Idle),
        send($.lease, 'Release', { from: $.self, token: $.held }),
      ]),
      on('SendWrite', ($) => [
        require($.status === $.Holding, 'not-holding'),
        require(!$.writing, 'write-pending'),
        set('writing', true),
        send($.lease, 'Write', { from: $.self, token: $.held }),
      ]),
      on('Granted', ($) => [
        require($.status === $.Requesting, 'not-requesting'),
        set('held', $.token),
        // A grant already revoked leaves the client idle.
        when($.token <= $.revoked, [set('status', $.Idle)], [set('status', $.Holding)]),
      ]),
      on('Denied', ($) => [
        require($.status === $.Requesting, 'not-requesting'),
        set('status', $.Idle),
      ]),
      on('Revoked', ($) => [
        when($.status === $.Holding, [
          require($.token === $.held, 'stale-revoke'),
          set('status', $.Idle),
        ], [
          require($.token > $.revoked, 'stale-revoke'),
          set('revoked', $.token),
        ]),
      ]),
      on('WriteDone', ($) => [require($.writing, 'no-write'), set('writing', false)]),
      on('WriteRefused', ($) => [require($.writing, 'no-write'), set('writing', false)]),
    ],
  }),

  configuration('two-clients', {
    instances: [
      instance('lease', 'Lease'),
      instance('c0', 'Client', { init: ($) => ({ lease: $.lease }) }),
      instance('c1', 'Client', { init: ($) => ({ lease: $.lease }) }),
    ],
    inputs: ['c0.RequestLease', 'c0.ReleaseLease', 'c0.SendWrite', 'c1.RequestLease', 'c1.ReleaseLease', 'c1.SendWrite', 'lease.Expire'],
    bounds: { transit: 8 },
    properties: [
      invariant('one-current-holder', ($) =>
        !($.c0.status === $.Holding && $.c1.status === $.Holding && $.c0.held === $.lease.lastToken && $.c1.held === $.lease.lastToken)),
    ],
  }),
]);
