// The turnstile of the polygraph field study, written by hand in poly's embedded surface (PT2.5, S71).
// Its twin is examples/field-studies/turnstile/turnstile.poly: the two give one AST digest.
import { module, union, machine, field, t, action, on, set, require, rejectProperty, implies, rejected } from '@cognitive-fab/poly/embed';

export default module('turnstile', [
  union('Mode', { LOCKED: {}, UNLOCKED: {} }),
  machine('Turnstile', {
    state: {
      state: field(t.named('Mode'), ($) => $.LOCKED),
      coins: field(t.int, () => 0, { check: { lo: 0, hi: 3 } }),
    },
    items: [
      action('COIN', {}),
      action('PUSH', {}),
      // COIN always unlocks and counts the coin, even when already UNLOCKED.
      on('COIN', ($) => [set('state', $.UNLOCKED), set('coins', $.coins + 1)]),
      // PUSH while LOCKED is the contract's named special rule: an observable rejection.
      on('PUSH', ($) => [
        require($.state === $.UNLOCKED, 'push-while-locked-is-noop'),
        set('state', $.LOCKED),
      ]),
      rejectProperty('push-locked-must-reject', ($) =>
        implies($.action === $.PUSH && $.pre.state === $.LOCKED, rejected('push-while-locked-is-noop'))),
    ],
  }),
]);
