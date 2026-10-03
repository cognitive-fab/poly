// Checkout across cart, inventory and payments: carts talk to one inventory and one payment service by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, terminal, isIn, invariant,
  configuration, instance, init, liveness,
} from '@cognitive-fab/poly/embed';

export default module('checkout', [
  enumType('CartStatus', ['fresh', 'open', 'reserving', 'paying', 'paid', 'failed', 'cancelling', 'cancelled', 'returned']),

  // The inventory: units move from available to reserved on Reserve, and back on Release.
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
      invariant('units-conserved', ($) => $.available + $.reserved === 2),
    ],
  }),

  // The payment service: accepts or declines every charge, and never takes the total above 4.
  machine('Payments', {
    service: true,
    state: {
      declining: field(t.bool, () => false),
      charged: field(t.range(0, 4), () => 0),
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

  // A cart: fresh until opened, then open, reserving, paying, and paid, failed or cancelled; a paid cart may be returned.
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
      action('Reserved', {}),
      action('OutOfStock', {}),
      action('Charged', {}),
      action('Declined', {}),
      action('Return', {}),
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
        require(isIn($.status, [$.open, $.reserving]), 'cannot-cancel'),
        when($.status === $.open, [set('status', $.cancelled)], [set('status', $.cancelling)]),
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
      on('Declined', ($) => [
        require($.status === $.paying, 'not-paying'),
        set('status', $.failed),
        send($.inv, 'Release', { qty: $.items }),
      ]),
    ],
  }),

  configuration('shop', {
    instances: [
      instance('inventory', 'Inventory'),
      instance('payments', 'Payments'),
      instance('cart', 'Cart', { count: 2, init: ($) => ({ inv: $.inventory, pay: $.payments }) }),
    ],
    inputs: ['cart[*].Open', 'cart[*].Add', 'cart[*].Checkout', 'cart[*].Cancel', 'payments.DeclineCards', 'payments.AcceptCards'],
    bounds: { transit: 4 },
    properties: [
      invariant('stock-conserved', ($) => $.inventory.available + $.inventory.reserved === init($.inventory.available) + init($.inventory.reserved)),
      liveness('checkout-settles', {
        from: ($) => isIn($.cart[$.i].status, [$.reserving, $.cancelling]),
        to: ($) => isIn($.cart[$.i].status, [$.paid, $.failed, $.cancelled]),
      }, { forall: ['i', 'cart'] }),
    ],
  }),
]);
