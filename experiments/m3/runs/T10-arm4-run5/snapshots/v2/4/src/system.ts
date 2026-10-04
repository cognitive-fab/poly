// T10: a lease with fencing tokens. One lease service, two clients, talking by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, when, send, configuration, instance,
  invariant, implies, forall,
} from '@cognitive-fab/poly/embed';

export default module('fencing', [
  enumType('Status', ['idle', 'requesting', 'holding']),

  machine('Lease', {
    service: true,
    state: {
      holder: field(t.ref('Client'), ($) => $.none),
      current: field(t.range(0, 2), () => 0),
      writes: field(t.range(0, 2), () => 0),
      wrote: field(t.bool, () => false),
    },
    items: [
      action('Acquire', { from: t.ref('Client') }),
      action('Release', { from: t.ref('Client'), token: t.range(0, 2) }),
      action('Write', { from: t.ref('Client'), token: t.range(0, 2) }),
      action('Expire', {}),
      on('Acquire', ($) => [
        when($.holder === $.none && $.current < 2, [
          set('holder', $.from),
          set('current', $.current + 1),
          set('wrote', false),
          send($.from, 'Granted', { token: $.current + 1 }),
        ], [
          send($.from, 'Denied', {}),
        ]),
      ], ['from']),
      on('Release', ($) => [
        when($.holder === $.from && $.current === $.token, [set('holder', $.none)]),
        send($.from, 'Released', {}),
      ], ['from', 'token']),
      on('Write', ($) => [
        when($.holder === $.from && $.current === $.token && !$.wrote && $.writes < 2, [
          set('writes', $.writes + 1),
          set('wrote', true),
          send($.from, 'WriteDone', {}),
        ], [
          send($.from, 'WriteRefused', {}),
        ]),
      ], ['from', 'token']),
      on('Expire', ($) => [
        require($.holder !== $.none, 'no-holder'),
        set('holder', $.none),
        send($.holder, 'Revoked', { token: $.current }),
      ]),
    ],
  }),

  machine('Client', {
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      held: field(t.range(0, 2), () => 0),
      writing: field(t.bool, () => false),
      revoked: field(t.range(0, 2), () => 0),
      svc: field(t.ref('Lease'), ($) => $.none),
    },
    items: [
      action('Acquire', {}),
      action('Release', {}),
      action('Write', {}),
      action('Granted', { token: t.range(1, 2) }),
      action('Denied', {}),
      action('Revoked', { token: t.range(1, 2) }),
      action('Released', {}),
      action('WriteDone', {}),
      action('WriteRefused', {}),
      on('Acquire', ($) => [
        require($.status === $.idle, 'not-idle'),
        set('status', $.requesting),
        send($.svc, 'Acquire', { from: $.self }),
      ]),
      on('Release', ($) => [
        require($.status === $.holding, 'not-holding'),
        set('status', $.releasing),
        send($.svc, 'Release', { from: $.self, token: $.held }),
      ]),
      on('Write', ($) => [
        require($.status === $.holding, 'not-holding'),
        require(!$.writing, 'write-pending'),
        set('writing', true),
        send($.svc, 'Write', { from: $.self, token: $.held }),
      ]),
      on('Granted', ($) => [
        require($.status === $.requesting, 'not-requesting'),
        set('held', $.token),
        when($.token <= $.revoked, [set('status', $.idle)], [set('status', $.holding)]),
      ], ['token']),
      on('Denied', ($) => [
        require($.status === $.requesting, 'not-requesting'),
        set('status', $.idle),
      ]),
      on('Released', ($) => [
        require($.status === $.releasing, 'not-releasing'),
        set('status', $.idle),
      ]),
      on('Revoked', ($) => [
        require($.status !== $.releasing, 'releasing'),
        when($.status === $.holding, [
          require($.token === $.held, 'stale-revoke'),
          set('status', $.idle),
        ], [
          require($.token > $.revoked, 'stale-revoke'),
          set('revoked', $.token),
        ]),
      ], ['token']),
      on('WriteDone', () => [set('writing', false)]),
      on('WriteRefused', () => [set('writing', false)]),
    ],
  }),

  // The two clients and the service, with every message delivered in any order.
  configuration('two-clients', {
    instances: [
      instance('lease', 'Lease'),
      instance('c', 'Client', { count: 2, init: ($) => ({ svc: $.lease }) }),
    ],
    inputs: ['c[*].Acquire', 'c[*].Release', 'c[*].Write', 'lease.Expire'],
    bounds: { transit: 8 },
    properties: [
      invariant('one-current-holder', ($) => forall('i', 'c', ($) => forall('j', 'c', ($) => implies(
        $.c[$.i].status === $.holding && $.c[$.i].held === $.lease.current
          && $.c[$.j].status === $.holding && $.c[$.j].held === $.lease.current,
        $.i === $.j)))),
      invariant('writes-bounded', ($) => implies($.lease.writes > 0, $.lease.current > 0)),
      invariant('one-write-per-grant', ($) => $.lease.writes <= $.lease.current),
    ],
  }),
]);
