// T10, a lease with fencing tokens: a lease service and two clients that talk by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, when, send, configuration, instance, invariant, implies,
} from '@cognitive-fab/poly/embed';

export default module('fencing', [
  enumType('Status', ['idle', 'requesting', 'holding', 'releasing', 'abandoning']),

  // The lease service: the holder, the last token granted (also the number of grants), the writes taken.
  machine('Lease', {
    service: true,
    state: {
      holder: field(t.ref('Client'), ($) => $.none),
      lastToken: field(t.range(0, 2), () => 0),
      writes: field(t.range(0, 2), () => 0),
      // Whether a write was taken since the last grant: one write per grant.
      wroteThisGrant: field(t.bool, () => false),
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
          set('wroteThisGrant', false),
          send($.from, 'Granted', { token: $.lastToken + 1 }),
        ], [
          send($.from, 'Denied', {}),
        ]),
      ]),
      // A release is always acknowledged; only the holder with the current token gives the lease back.
      on('Release', ($) => [
        when($.holder !== $.none && $.holder === $.from && $.token === $.lastToken, [set('holder', $.none)]),
        send($.from, 'Released', {}),
      ]),
      on('Write', ($) => [
        when($.holder !== $.none && $.holder === $.from && $.token === $.lastToken && !$.wroteThisGrant && $.writes < 2, [
          set('writes', $.writes + 1),
          set('wroteThisGrant', true),
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
      invariant('one-write-per-grant', ($) => $.writes <= $.lastToken),
    ],
  }),

  // A client: its status, the last token granted to it, whether a write waits for an answer, and the newest
  // token revoked while it did not hold the lease.
  machine('Client', {
    service: true,
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      held: field(t.range(0, 2), () => 0),
      writing: field(t.bool, () => false),
      revoked: field(t.range(0, 2), () => 0),
      lease: field(t.ref('Lease'), ($) => $.none),
    },
    items: [
      action('RequestLease', {}),
      action('ReleaseLease', {}),
      action('SendWrite', {}),
      action('CancelAcquire', {}),
      action('Granted', { token: t.range(0, 2) }),
      action('Denied', {}),
      action('Revoked', { token: t.range(0, 2) }),
      action('Released', {}),
      action('WriteDone', {}),
      action('WriteRefused', {}),

      on('RequestLease', ($) => [
        require($.status === $.idle, 'not-idle'),
        set('status', $.requesting),
        send($.lease, 'Acquire', { from: $.self }),
      ]),
      on('ReleaseLease', ($) => [
        require($.status === $.holding, 'not-holding'),
        set('status', $.releasing),
        send($.lease, 'Release', { from: $.self, token: $.held }),
      ]),
      on('SendWrite', ($) => [
        require($.status === $.holding, 'not-holding'),
        require(!$.writing, 'write-pending'),
        set('writing', true),
        send($.lease, 'Write', { from: $.self, token: $.held }),
      ]),
      on('CancelAcquire', ($) => [
        require($.status === $.requesting, 'not-requesting'),
        set('status', $.abandoning),
      ]),
      on('Granted', ($) => [
        require($.status === $.requesting || $.status === $.abandoning, 'not-requesting'),
        set('held', $.token),
        when($.status === $.abandoning, [
          // An abandoned request's grant is given straight back.
          set('status', $.releasing),
          send($.lease, 'Release', { from: $.self, token: $.token }),
        ], [
          // A grant already revoked leaves the client idle.
          when($.token <= $.revoked, [set('status', $.idle)], [set('status', $.holding)]),
        ]),
      ]),
      on('Denied', ($) => [
        require($.status === $.requesting || $.status === $.abandoning, 'not-requesting'),
        set('status', $.idle),
      ]),
      on('Revoked', ($) => [
        when($.status === $.holding, [
          require($.token === $.held, 'stale-revoke'),
          set('status', $.idle),
        ], [
          require($.status !== $.releasing, 'releasing'),
          require($.token > $.revoked, 'stale-revoke'),
          set('revoked', $.token),
        ]),
      ]),
      on('Released', ($) => [
        require($.status === $.releasing, 'not-releasing'),
        set('status', $.idle),
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
        !($.c0.status === $.holding && $.c1.status === $.holding && $.c0.held === $.lease.lastToken && $.c1.held === $.lease.lastToken)),
    ],
  }),
]);
