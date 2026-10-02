// P1, book loans: one Book machine per book id, created by add.
import { module, enumType, machine, field, t, action, on, require, set, terminal, invariant } from '@cognitive-fab/poly/embed';

export default module('library', [
  // 'none' is the state of a book instance before add takes effect; it is never observable.
  enumType('Status', ['none', 'available', 'lent', 'retired']),
  machine('Book', {
    state: {
      status: field(t.named('Status'), ($) => $.none),
      loans: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => $.status === $.retired),
      action('Add', {}),
      action('Lend', {}),
      action('GiveBack', {}),
      action('Retire', {}),
      on('Add', ($) => [require($.status === $.none, 'exists'), set('status', $.available)]),
      on('Lend', ($) => [
        require($.status === $.available, 'not-available'),
        require($.loans < 3, 'loan-limit'),
        set('status', $.lent),
        set('loans', $.loans + 1),
      ]),
      on('GiveBack', ($) => [require($.status === $.lent, 'not-lent'), set('status', $.available)]),
      on('Retire', ($) => [require($.status === $.available, 'not-available'), set('status', $.retired)]),
      invariant('loans-bounded', ($) => $.loans <= 3),
    ],
  }),
]);
