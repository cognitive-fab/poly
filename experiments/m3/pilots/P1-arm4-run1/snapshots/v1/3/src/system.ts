// P1, book loans: one Book machine per book id, created by add.
import { module, enumType, machine, field, t, action, on, require, set, terminal, invariant } from '@cognitive-fab/poly/embed';

export default module('library', [
  // 'absent' is the state of a book instance before add takes effect; it is never observable.
  enumType('Status', ['absent', 'available', 'lent', 'retired']),
  machine('Book', {
    state: {
      status: field(t.named('Status'), ($) => $.absent),
      loans: field(t.range(0, 3), () => 0),
      renewed: field(t.bool, () => false),
    },
    items: [
      terminal(($) => $.status === $.retired),
      action('Add', {}),
      action('Lend', {}),
      action('GiveBack', {}),
      action('Retire', {}),
      action('Renew', {}),
      on('Add', ($) => [require($.status === $.absent, 'exists'), set('status', $.available)]),
      on('Lend', ($) => [
        require($.status === $.available, 'not-available'),
        require($.loans < 3, 'loan-limit'),
        set('status', $.lent),
        set('loans', $.loans + 1),
      ]),
      on('GiveBack', ($) => [require($.status === $.lent, 'not-lent'), set('status', $.available), set('renewed', false)]),
      on('Renew', ($) => [
        require($.status === $.lent, 'not-lent'),
        require(!$.renewed, 'already-renewed'),
        set('renewed', true),
      ]),
      invariant('renewed-only-when-lent', ($) => implies($.renewed, $.status === $.lent)),
      on('Retire', ($) => [require($.status === $.available, 'not-available'), set('status', $.retired)]),
      invariant('loans-bounded', ($) => $.loans <= 3),
    ],
  }),
]);
