// Checkout across cart, inventory and payments: three machines that talk by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, terminal, invariant, isIn,
  configuration, instance, implies, init,
} from '@cognitive-fab/poly/embed';

export default module('checkout', [
  enumType('CartStatus', ['fresh', 'open', 'reserving', 'paying', 'paid', 'failed', 'cancelling', 'cancelled', 'returned', 'declined']),

  // One inventory: units available, units reserved for carts.
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
        set('available', $.available + $.qty),
        set('reserved', $.reserved - $.qty),
      ]),
      invariant('units-conserved', ($) => $.available + $.reserved <= 2),
    ],
  }),

  // One payment service: accepts or declines every charge, and never charges more than 4 in total.
  machine('Payments', {
    service: true,
    state: {
      charged: field(t.range(0, 4), () => 0),
      declining: field(t.bool, () => false),
    },
    items: [
      action('DeclineCards', {}),
      action('AcceptCards', {}),
      action('Charge', { from: t.ref('Cart'), amount: t.range(1, 2) }),
      action('Refund', { amount: t.range(1, 2) }),
      on('Refund', ($) => [require($.charged >= $.amount, 'not-charged'), set('charged', $.charged - $.amount)]),
      on('DeclineCards', ($) => [require(!$.declining, 'already-declining'), set('declining', true)]),
      on('AcceptCards', ($) => [require($.declining, 'already-accepting'), set('declining', false)]),
      on('Charge', ($) => [
        when(!$.declining && $.charged + $.amount <= 4, [
          set('charged', $.charged + $.amount),
          send($.from, 'Charged', {}),
        ], [
          send($.from, 'Declined', {}),
        ]),
      ]),
    ],
  }),

  // A cart, named by the caller. `fresh` is the state before Open, which creates it.
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
      action('Add', {}),
      action('Checkout', {}),
      action('Cancel', {}),
      action('Return', {}),
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
        require(isIn($.status, [$.open, $.reserving]), 'not-cancellable'),
        when($.status === $.open, [set('status', $.cancelled)], [set('status', $.cancelling)]),
      ]),
      // A paid cart is returned: refunded by the payment service, its units given back to the inventory.
      on('Return', ($) => [
        require($.status === $.paid, 'not-paid'),
        set('status', $.returned),
        send($.pay, 'Refund', { amount: $.items }),
        send($.inv, 'Release', { qty: $.items }),
      ]),
      on('Reserved', ($) => [
        require(isIn($.status, [$.reserving, $.cancelling]), 'not-reserving'),
        when($.status === $.reserving, [
          set('status', $.paying),
          send($.pay, 'Charge', { from: $.self, amount: $.items }),
        ], [
          set('status', $.cancelled),
          send($.inv, 'Release', { qty: $.items }),
        ]),
      ]),
      on('OutOfStock', ($) => [
        require(isIn($.status, [$.reserving, $.cancelling]), 'not-reserving'),
        when($.status === $.reserving, [set('status', $.failed)], [set('status', $.cancelled)]),
      ]),
      on('Charged', ($) => [require($.status === $.paying, 'not-paying'), set('status', $.paid)]),
      // A declined cart keeps its units reserved until it retries or abandons.
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
      invariant('checked-out-has-items', ($) => implies(isIn($.status, [$.reserving, $.paying, $.paid, $.cancelling, $.returned, $.declined]), $.items > 0)),
    ],
  }),

  configuration('two-carts', {
    instances: [
      instance('inv', 'Inventory'),
      instance('pay', 'Payments'),
      instance('cart', 'Cart', { count: 2, init: ($) => ({ inv: $.inv, pay: $.pay }) }),
    ],
    inputs: ['cart[*].Open', 'cart[*].Add', 'cart[*].Checkout', 'cart[*].Cancel', 'cart[*].Return', 'cart[*].Retry', 'cart[*].Abandon', 'pay.DeclineCards', 'pay.AcceptCards'],
    bounds: { transit: 4 },
    properties: [
      invariant('units-conserved', ($) => $.inv.available + $.inv.reserved === init($.inv.available)),
    ],
  }),
]);
