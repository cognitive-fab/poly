// A machine with effects, timers and attached children, written by hand in poly's embedded surface
// (PT2.5, S71). Its twin is workshop.poly beside it: the two give one AST digest and one verdict.
import {
  module, enumType, union, machine, field, t, action, on, require, reject, set, setEntry, emit, after, cancel, spawn,
  signal, match, arm, pattern, bind, ctor, effect, kind, labels, cls, retry, ok, failed, terminal, invariant,
  stepProperty, pathProperty, composeInvariant, implies, isIn, count, spawned,
} from '@cognitive-fab/poly/embed';

export default module('workshop', [
  enumType('JobStatus', ['Idle', 'Running', 'Done', 'Failed']),
  union('Part', { Blank: {}, Cut: { length: t.range(1, 3) } }),
  machine('Drill', {
    state: { bit: field(t.range(0, 2), () => 0) },
    items: [
      terminal(($) => $.bit === 2),
      action('Load', { bit: t.range(1, 2) }),
      action('Finish', {}),
      on('Load', ($) => [require($.bit > 0, 'no-bit'), set('bit', $.bit)], ['bit']),
      on('Finish', () => [set('bit', 2)]),
    ],
  }),
  machine('Job', {
    state: {
      status: field(t.named('JobStatus'), ($) => $.Idle),
      part: field(t.named('Part'), ($) => $.Blank),
      tries: field(t.range(0, 2), () => 0),
      notes: field(t.map(t.named('JobStatus'), t.bool), () => ({ Idle: false, Running: false, Done: false, Failed: false })),
    },
    items: [
      terminal(($) => isIn($.status, [$.Done, $.Failed])),
      action('Start', { length: t.range(1, 3) }),
      action('Charged', {}),
      action('Declined', { code: t.string.check(['declined']) }),
      action('Timeout', { reason: t.string.check(['late'], 'strict') }),
      action('Drilled', {}),
      on('Start', ($) => [
        require($.status === $.Idle, 'not-idle'),
        require(!($.tries >= 2), 'too-many'),
        set('status', $.Running),
        set('part', ctor('Cut', { length: $.length })),
        set('tries', $.tries + 1),
        setEntry('notes', $.Running, true),
        emit('charge', { amount: $.length * 10 }),
        after('5m', 'Timeout', { reason: 'late' }, 'watchdog'),
        spawn('Drill', 'drill', { create: ['Load', { bit: 1 }], complete: 'Drilled' }),
      ], ['length']),
      on('Charged', ($) => [
        require($.status === $.Running, 'not-running'),
        require(!$.notes[$.Done], 'charged'),
        match($.part, [
          arm(pattern('Cut', { length: 3 }), [setEntry('notes', $.Done, true), cancel('watchdog')]),
          arm(pattern('Cut', { length: bind('n') }), [
            require($.n < 3, 'long'),
            setEntry('notes', $.Done, true),
            signal('drill', null, 'Finish', []),
          ]),
          arm(pattern('Blank'), [reject('blank')]),
        ]),
      ]),
      on('Declined', ($) => [require($.status === $.Running, 'not-running'), set('status', $.Failed), cancel('watchdog')], ['code']),
      on('Timeout', ($) => [set('status', $.Failed)], ['reason']),
      on('Drilled', ($) => [require($.status === $.Running, 'not-running'), set('status', $.Done)]),
      effect('charge', { amount: t.int }, [
        kind('workshop.charge'),
        labels(['egress:external']),
        cls('compensable'),
        retry(2, '100ms', '2s'),
        ok('Charged', []),
        failed('Declined', { code: 'declined' }),
      ]),
      invariant('tries-bounded', ($) => $.tries <= 2 && -$.tries <= 0),
      stepProperty('done-was-running', ($) => implies($.post.status === $.Done, $.pre.status === $.Running || $.pre.status === $.Done)),
      pathProperty('charge-once', () => count('workshop.charge') <= 1),
      composeInvariant('drill-loaded', ($) => implies(spawned($.drill), $.children.drill.bit >= 0)),
    ],
  }),
]);
