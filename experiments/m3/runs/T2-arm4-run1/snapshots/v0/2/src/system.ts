// Orders and inventory: one inventory and orders that talk to it by messages.
import {
  module, enumType, machine, field, t, action, on, require, reject, set, send, when, terminal, invariant,
  configuration, instance, isIn, implies, count, sum, forall, liveness, init, ALL,
} from '@cognitive-fab/poly/embed';

export default module('shop', [
  enumType('Status', ['new', 'pending', 'confirmed', 'rejected', 'cancelling', 'cancelled']),

  machine('Inventory', {
    service: true,
    state: {
      available: field(t.range(0, 3), () => 1),
      reserved: field(t.range(0, 3), () => 0),
    },
    items: [
      action('Restock', {}),
      action('Reserve', { from: t.ref('Order'), qty: t.range(1, 2) }),
      action('Release', { qty: t.range(1, 2) }),

      on('Restock', ($) => [
        require($.available + $.reserved < 3, 'inventory-full'),
        set('available', $.available + 1),
      ]),
      // Reserves the units if that many are available, and answers either way.
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
        require($.available + $.qty <= 3, 'inventory-full'),
        set('reserved', $.reserved - $.qty),
        set('available', $.available + $.qty),
      ]),

      invariant('holds-at-most-3', ($) => $.available + $.reserved <= 3),
    ],
  }),

  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.new),
      qty: field(t.range(0, 2), () => 0),
      inv: field(t.ref('Inventory'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.rejected, $.cancelled])),
      action('Place', { qty: t.range(1, 2) }),
      action('Cancel', {}),
      action('Reserved', {}),
      action('OutOfStock', {}),

      on('Place', ($) => [
        require($.status === $.new, 'order-exists'),
        set('status', $.pending),
        set('qty', $.qty),
        send($.inv, 'Reserve', { from: $.self, qty: $.qty }),
      ]),
      on('Cancel', ($) => [
        require(isIn($.status, [$.pending, $.confirmed]), 'not-cancellable'),
        when($.status === $.confirmed, [
          set('status', $.cancelled),
          send($.inv, 'Release', { qty: $.qty }),
        ], [
          set('status', $.cancelling),
        ]),
      ]),
      // The inventory reserved the units: a pending order is confirmed; a cancelling one gives them back.
      on('Reserved', ($) => [
        require(isIn($.status, [$.pending, $.cancelling]), 'not-waiting'),
        when($.status === $.pending, [
          set('status', $.confirmed),
        ], [
          set('status', $.cancelled),
          send($.inv, 'Release', { qty: $.qty }),
        ]),
      ]),
      on('OutOfStock', ($) => [
        require(isIn($.status, [$.pending, $.cancelling]), 'not-waiting'),
        when($.status === $.pending, [
          set('status', $.rejected),
        ], [
          set('status', $.cancelled),
        ]),
      ]),

      invariant('placed-has-qty', ($) => implies($.status !== $.new, $.qty >= 1)),
    ],
  }),

  configuration('two-orders', {
    instances: [
      instance('inv', 'Inventory'),
      instance('order', 'Order', { count: 2, init: ($) => ({ inv: $.inv }) }),
    ],
    inputs: ['order[*].Place', 'order[*].Cancel', 'inv.Restock'],
    bounds: { transit: 4 },
    properties: [
      invariant('stock-bounded', ($) => $.inv.available + $.inv.reserved <= 3),
      // Every confirmed order's units are reserved.
      invariant('confirmed-reserved', ($) => count($.order[ALL].status === $.confirmed) <= $.inv.reserved),
      liveness('settles', {
        from: ($) => isIn($.order[$.i].status, [$.pending, $.cancelling]),
        to: ($) => isIn($.order[$.i].status, [$.confirmed, $.rejected, $.cancelled]),
      }, { forall: ['i', 'order'] }),
    ],
  }),
]);
