import { module, enumType, machine, field, t, action, on, set, let_, when } from '@cognitive-fab/poly/embed';
export default module('probe', [
  enumType('S', ['a', 'b']),
  machine('M', {
    state: { s: field(t.named('S'), ($) => $.a), x: field(t.named('S'), ($) => $.a) },
    items: [
      action('Go', { k: t.int.check(0, 1) }),
      on('Go', ($) => [
        when($.k === 0, [let_('n', $.b)], [let_('n', $.a)]),
        set('s', $.n),
      ]),
    ],
  }),
]);
