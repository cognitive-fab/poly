import { module, enumType, machine, field, t, action, on, set, guard, isIn } from '@cognitive-fab/poly/embed';
export default module('probe', [
  enumType('S', ['a', 'b']),
  machine('M', {
    state: { s: field(t.named('S'), ($) => $.a) },
    items: [
      action('Go', { k: t.int.check(0, 1, 'strict') }),
      guard(($) => isIn($.s, [$.b]), 'done'),
      on('Go', ($) => [set('s', $.b)]),
    ],
  }),
]);
