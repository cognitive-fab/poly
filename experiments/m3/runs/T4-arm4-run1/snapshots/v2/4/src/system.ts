// Checkout across cart, inventory and payments: three kinds of machine that talk only by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, terminal, invariant,
  configuration, instance, isIn, is, implies, count, init, liveness, ALL,
} from '@cognitive-fab/poly/embed';

export default module('checkout', [
  enumType('CartStatus', ['fresh', 'open', 'reserving', 'paying', 'paid', 'failed', 'cancelling', 'cancelled', 'returned', 'declined']),

  machine('Inventory', {
    service: true,
    state: {
      available: field(t.range(0, 2), () => 2),
      reserved: field(t.range(0, 2), () => 0),
    },
    items: [
      action('Reserve', { from: t.ref('Cart'), qty: t.range(1, 2) }),
      action('Release', { qty: t.range(1, 2) }),
      on('Reserve', ($) => [
        when($.available >= $.qty, [
          set('available', $.available - $.qty),
          set('reserved', $.reserved + $.qty),
          send($.from, 'Reserved', {}),
        ], [
          send($.from, 'OutOfStock', {}),
        ]),
      ]),
      on('Release', ($) => [
        require($.reserved >= $.qty, 'not-reserved'),
        set('reserved', $.reserved - $.qty),
        set('available', $.available + $.qty),
      ]),
      invariant('stock-conserved', ($) => $.available + $.reserved === 2),
    ],
  }),

  machine('Payments', {
    service: true,
    state: {
      charged: field(t.range(0, 4), () => 0),
      declining: field(t.bool, () => false),
    },
    items: [
      action('Charge', { from: t.ref('Cart'), amount: t.range(1, 2) }),
      action('DeclineCards', {}),
      action('AcceptCards', {}),
      action('Refund', { amount: t.range(1, 2) }),
      on('Refund', ($) => [
        require($.charged >= $.amount, 'not-charged'),
        set('charged', $.charged - $.amount),
      ]),
      on('Charge', ($) => [
        when(!$.declining && $.charged + $.amount <= 4, [
          set('charged', $.charged + $.amount),
          send($.from, 'Charged', {}),
        ], [
          send($.from, 'Declined', {}),
        ]),
      ]),
      on('DeclineCards', ($) => [require(!$.declining, 'already-declining'), set('declining', true)]),
      on('AcceptCards', ($) => [require($.declining, 'already-accepting'), set('declining', false)]),
    ],
  }),

  machine('Cart', {
    state: {
      status: field(t.named('CartStatus'), ($) => $.fresh),
      items: field(t.range(0, 2), () => 0),
      inv: field(t.ref('Inventory'), ($) => $.none),
      pay: field(t.ref('Payments'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.failed, $.cancelled, $.returned])),
      action('Open', {}),
      action('Return', {}),
      action('Add', {}),
      action('Checkout', {}),
      action('Cancel', {}),
      action('Reserved', {}),
      action('OutOfStock', {}),
      action('Charged', {}),
      action('Declined', {}),
      action('Retry', {}),
      action('Abandon', {}),
      on('Open', ($) => [require($.status === $.fresh, 'cart-exists'), set('status', $.open)]),
      on('Add', ($) => [
        require($.status === $.open, 'not-open'),
        require($.items < 2, 'cart-full'),
        set('items', $.items + 1),
      ]),
      on('Checkout', ($) => [
        require($.status === $.open, 'not-open'),
        require($.items > 0, 'empty-cart'),
        set('status', $.reserving),
        send($.inv, 'Reserve', { from: $.self, qty: $.items }),
      ]),
      on('Cancel', ($) => [
        require($.status !== $.paying, 'payment-in-progress'),
        require($.status === $.open || $.status === $.reserving, 'not-cancellable'),
        when($.status === $.open, [set('status', $.cancelled)], [set('status', $.cancelling)]),
      ]),
      on('Reserved', ($) => [
        require($.status === $.reserving || $.status === $.cancelling, 'not-reserving'),
        when($.status === $.reserving, [
          set('status', $.paying),
          send($.pay, 'Charge', { from: $.self, amount: $.items }),
        ], [
          set('status', $.cancelled),
          send($.inv, 'Release', { qty: $.items }),
        ]),
      ]),
      on('OutOfStock', ($) => [
        require($.status === $.reserving || $.status === $.cancelling, 'not-reserving'),
        when($.status === $.reserving, [set('status', $.failed)], [set('status', $.cancelled)]),
      ]),
      on('Charged', ($) => [require($.status === $.paying, 'not-paying'), set('status', $.paid)]),
      on('Return', ($) => [
        require($.status === $.paid, 'not-paid'),
        set('status', $.returned),
        send($.pay, 'Refund', { amount: $.items }),
        send($.inv, 'Release', { qty: $.items }),
      ]),
      // A declined card keeps the units reserved: the customer retries or abandons.
      on('Declined', ($) => [require($.status === $.paying, 'not-paying'), set('status', $.declined)]),
      on('Retry', ($) => [
        require($.status === $.declined, 'not-declined'),
        set('status', $.paying),
        send($.pay, 'Charge', { from: $.self, amount: $.items }),
      ]),
      on('Abandon', ($) => [
        require($.status === $.declined, 'not-declined'),
        set('status', $.failed),
        send($.inv, 'Release', { qty: $.items }),
      ]),
      invariant('in-checkout-has-units', ($) =>
        implies(isIn($.status, [$.reserving, $.paying, $.paid, $.cancelling, $.returned, $.declined]), $.items > 0)),
    ],
  }),

  configuration('shop', {
    instances: [
      instance('inv', 'Inventory'),
      instance('pay', 'Payments'),
      instance('cart', 'Cart', { count: 2, init: ($) => ({ inv: $.inv, pay: $.pay }) }),
    ],
    inputs: [
      'cart[*].Open', 'cart[*].Add', 'cart[*].Checkout', 'cart[*].Cancel', 'cart[*].Return',
      'cart[*].Retry', 'cart[*].Abandon',
      'pay.DeclineCards', 'pay.AcceptCards',
    ],
    bounds: { transit: 4 },
    properties: [
      invariant('stock-conserved', ($) => $.inv.available + $.inv.reserved === 2),
      // A refund and its release travel separately: the released units may be sold and charged again before
      // the refund arrives, so charged may briefly exceed the stock, though never twice the stock.
      invariant('charged-within-twice-stock', ($) => $.pay.charged <= 2 * init($.inv.available)),
      invariant('paid-within-stock', ($) => count(is($.cart[ALL], 'paid')) <= init($.inv.available)),
      liveness('checkout-settles', {
        from: ($) => isIn($.cart[$.i].status, [$.reserving, $.paying, $.cancelling]),
        to: ($) => isIn($.cart[$.i].status, [$.paid, $.failed, $.cancelled]),
      }, { forall: ['i', 'cart'] }),
    ],
  }),
]);
