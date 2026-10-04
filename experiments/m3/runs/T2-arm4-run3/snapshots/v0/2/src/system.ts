// Orders and inventory: one inventory and orders that reserve units from it by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, terminal, invariant,
  configuration, instance, isIn,
} from '@cognitive-fab/poly/embed';

export default module('shop', [
  enumType('Status', ['idle', 'pending', 'confirmed', 'rejected', 'cancelling', 'cancelled']),

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
      on('Reserve', ($) => [
        when($.available >= $.qty, [
          set('available', $.available - $.qty),
          set('reserved', $.reserved + $.qty),
          send($.from, 'Reserved', {}),
        ], [
          send($.from, 'OutOfStock', {}),
        ]),
      ], ['from', 'qty']),
      on('Release', ($) => [
        require($.reserved >= $.qty, 'not-reserved'),
        set('reserved', $.reserved - $.qty),
        set('available', $.available + $.qty),
      ], ['qty']),
      invariant('at-most-three', ($) => $.available + $.reserved <= 3),
    ],
  }),

  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.idle),
      qty: field(t.range(0, 2), () => 0),
      inv: field(t.ref('Inventory'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.rejected, $.cancelled])),
      action('Place', { qty: t.int.check([1, 2], 'strict') }),
      action('Cancel', {}),
      action('Reserved', {}),
      action('OutOfStock', {}),
      on('Place', ($) => [
        require($.status === $.idle, 'order-exists'),
        set('status', $.pending),
        set('qty', $.qty),
        send($.inv, 'Reserve', { from: $.self, qty: $.qty }),
      ], ['qty']),
      on('Cancel', ($) => [
        require(isIn($.status, [$.pending, $.confirmed]), 'not-cancellable'),
        when($.status === $.confirmed, [
          set('status', $.cancelled),
          send($.inv, 'Release', { qty: $.qty }),
        ], [
          set('status', $.cancelling),
        ]),
      ]),
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
      invariant('placed-has-qty', ($) => ($.status === $.idle) === ($.qty === 0)),
    ],
  }),

  configuration('shop', {
    instances: [
      instance('inv', 'Inventory'),
      instance('order', 'Order', { count: 2, init: ($) => ({ inv: $.inv }) }),
    ],
    inputs: ['order[*].Place', 'order[*].Cancel', 'inv.Restock'],
    bounds: { transit: 4 },
    properties: [
      invariant('stock-bounded', ($) => $.inv.available + $.inv.reserved <= 3),
    ],
  }),
]);
