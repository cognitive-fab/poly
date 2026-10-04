// T10, a lease with fencing tokens: a lease service and two clients that talk by messages.
import {
  module, union, machine, field, t, action, on, require, set, send, when, is, configuration, instance, invariant,
} from '@cognitive-fab/poly/embed';

export default module('fencing', [
  union('Status', { Idle: {}, Requesting: {}, Holding: {} }),

  // The lease service: grants at most 2 leases (tokens 1 and 2) and takes at most 2 writes.
  machine('Lease', {
    service: true,
    state: {
      holder: field(t.ref('Client'), ($) => $.none),
      token: field(t.range(0, 2), () => 0),
      writes: field(t.range(0, 2), () => 0),
    },
    items: [
      action('Acquire', { from: t.ref('Client') }),
      action('Release', { from: t.ref('Client'), token: t.range(0, 2) }),
      action('Write', { from: t.ref('Client'), token: t.range(0, 2) }),
      action('Expire', {}),
      on('Acquire', ($) => [
        when($.holder === $.none && $.token < 2, [
          set('holder', $.from),
          set('token', $.token + 1),
          send($.from, 'Granted', { token: $.token + 1 }),
        ], [
          send($.from, 'Denied', {}),
        ]),
      ], ['from']),
      // A release from anyone but the holder with the current token is ignored: a rejected step changes nothing.
      on('Release', ($) => [
        require($.holder !== $.none && $.from === $.holder && $.token === $.pre.token, 'not-current-holder'),
        set('holder', $.none),
      ], ['from', 'token']),
      on('Write', ($) => [
        when($.holder !== $.none && $.from === $.holder && $.token === $.pre.token && $.writes < 2, [
          set('writes', $.writes + 1),
          send($.from, 'WriteDone', {}),
        ], [
          send($.from, 'WriteRefused', {}),
        ]),
      ], ['from', 'token']),
      on('Expire', ($) => [
        require($.holder !== $.none, 'no-holder'),
        set('holder', $.none),
        send($.holder, 'Revoked', { token: $.token }),
      ]),
    ],
  }),

  machine('Client', {
    state: {
      status: field(t.named('Status'), ($) => $.Idle),
      token: field(t.range(0, 2), () => 0),
      writing: field(t.bool, () => false),
      revoked: field(t.range(0, 2), () => 0),
      svc: field(t.ref('Lease'), ($) => $.none),
    },
    items: [
      action('DoAcquire', {}),
      action('DoRelease', {}),
      action('DoWrite', {}),
      action('Granted', { token: t.range(1, 2) }),
      action('Denied', {}),
      action('Revoked', { token: t.range(1, 2) }),
      action('WriteDone', {}),
      action('WriteRefused', {}),
      on('DoAcquire', ($) => [
        require(is($.status, 'Idle'), 'not-idle'),
        set('status', $.Requesting),
        send($.svc, 'Acquire', { from: $.self }),
      ]),
      on('DoRelease', ($) => [
        require(is($.status, 'Holding'), 'not-holding'),
        set('status', $.Idle),
        send($.svc, 'Release', { from: $.self, token: $.token }),
      ]),
      on('DoWrite', ($) => [
        require(is($.status, 'Holding'), 'not-holding'),
        require(!$.writing, 'write-pending'),
        set('writing', true),
        send($.svc, 'Write', { from: $.self, token: $.token }),
      ]),
      // A Granted whose token was already revoked leaves the client idle.
      on('Granted', ($) => [
        require(is($.status, 'Requesting'), 'not-requesting'),
        set('token', $.token),
        when($.token <= $.revoked, [set('status', $.Idle)], [set('status', $.Holding)]),
      ], ['token']),
      on('Denied', ($) => [
        require(is($.status, 'Requesting'), 'not-requesting'),
        set('status', $.Idle),
      ]),
      on('Revoked', ($) => [
        when(is($.status, 'Holding'), [
          require($.token === $.pre.token, 'stale-revoke'),
          set('status', $.Idle),
        ], [
          require($.token > $.revoked, 'stale-revoke'),
          set('revoked', $.token),
        ]),
      ], ['token']),
      on('WriteDone', ($) => [require($.writing, 'no-write'), set('writing', false)]),
      on('WriteRefused', ($) => [require($.writing, 'no-write'), set('writing', false)]),
    ],
  }),

  configuration('two-clients', {
    instances: [
      instance('lease', 'Lease'),
      instance('c0', 'Client', { init: ($) => ({ svc: $.lease }) }),
      instance('c1', 'Client', { init: ($) => ({ svc: $.lease }) }),
    ],
    inputs: ['c0.DoAcquire', 'c0.DoRelease', 'c0.DoWrite', 'c1.DoAcquire', 'c1.DoRelease', 'c1.DoWrite', 'lease.Expire'],
    bounds: { transit: 4 },
    properties: [
      invariant('one-current-holder', ($) =>
        !(is($.c0.status, 'Holding') && $.c0.token === $.lease.token && is($.c1.status, 'Holding') && $.c1.token === $.lease.token)),
      invariant('token-not-ahead', ($) => $.c0.token <= $.lease.token && $.c1.token <= $.lease.token),
    ],
  }),
]);
