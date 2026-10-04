// T10, a lease with fencing tokens: a lease service and two clients that talk by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, implies,
  stepProperty, invariant, configuration, instance,
} from '@cognitive-fab/poly/embed';

export default module('lease', [
  enumType('Status', ['idle', 'requesting', 'holding']),

  // The lease service: grants at most 2 leases (tokens 1 and 2) and takes at most 2 writes.
  machine('Service', {
    service: true,
    state: {
      holder: field(t.ref('Client'), ($) => $.none),
      lastToken: field(t.range(0, 2), () => 0),
      writes: field(t.range(0, 2), () => 0),
      // Whether a write was taken since the last grant: one write per grant.
      wrote: field(t.bool, () => false),
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
      // A release from anyone but the holder with the current token is ignored.
      on('Release', ($) => [
        require($.holder !== $.none && $.holder === $.from && $.token === $.lastToken, 'not-current-holder'),
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
      invariant('holder-has-token', ($) => implies($.holder !== $.none, $.lastToken > 0)),
      stepProperty('writes-only-from-current-holder', ($) =>
        implies($.action === $.Write && $.post.writes !== $.pre.writes,
          $.from === $.pre.holder && $.token === $.pre.lastToken)),
    ],
  }),

  machine('Client', {
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      token: field(t.range(0, 2), () => 0),
      writing: field(t.bool, () => false),
      // The newest token revoked while this client did not hold the lease.
      revoked: field(t.range(0, 2), () => 0),
      lease: field(t.ref('Service'), ($) => $.none),
    },
    items: [
      action('Acquire', {}),
      action('Release', {}),
      action('Write', {}),
      action('Granted', { token: t.range(0, 2) }),
      action('Denied', {}),
      action('Revoked', { token: t.range(0, 2) }),
      action('WriteDone', {}),
      action('WriteRefused', {}),
      on('Acquire', ($) => [
        require($.status === $.idle, 'not-idle'),
        set('status', $.requesting),
        send($.lease, 'Acquire', { from: $.self }),
      ]),
      on('Release', ($) => [
        require($.status === $.holding, 'not-holding'),
        set('status', $.idle),
        send($.lease, 'Release', { from: $.self, token: $.token }),
      ]),
      on('Write', ($) => [
        require($.status === $.holding, 'not-holding'),
        require(!$.writing, 'write-pending'),
        set('writing', true),
        send($.lease, 'Write', { from: $.self, token: $.token }),
      ]),
      // A grant whose token was already revoked leaves the client idle.
      on('Granted', ($) => [
        require($.status === $.requesting, 'not-requesting'),
        set('token', $.token),
        when($.token <= $.revoked, [set('status', $.idle)], [set('status', $.holding)]),
      ]),
      on('Denied', ($) => [
        require($.status === $.requesting, 'not-requesting'),
        set('status', $.idle),
      ]),
      on('Revoked', ($) => [
        when($.status === $.holding, [
          require($.token === $.pre.token, 'not-own-token'),
          set('status', $.idle),
        ], [
          require($.token > $.revoked, 'stale-revoke'),
          set('revoked', $.token),
        ]),
      ]),
      on('WriteDone', ($) => [require($.writing, 'no-write'), set('writing', false)]),
      on('WriteRefused', ($) => [require($.writing, 'no-write'), set('writing', false)]),
    ],
  }),

  configuration('lease-two-clients', {
    instances: [
      instance('lease', 'Service'),
      instance('c0', 'Client', { init: ($) => ({ lease: $.lease }) }),
      instance('c1', 'Client', { init: ($) => ({ lease: $.lease }) }),
    ],
    inputs: ['c0.Acquire', 'c0.Release', 'c0.Write', 'c1.Acquire', 'c1.Release', 'c1.Write', 'lease.Expire'],
    bounds: { transit: 8 },
    properties: [
      invariant('one-current-holder', ($) =>
        !($.c0.status === $.holding && $.c0.token === $.lease.lastToken
          && $.c1.status === $.holding && $.c1.token === $.lease.lastToken)),
    ],
  }),
]);
