// Orders and inventory: one inventory and orders that reserve units from it by messages.
import {
  module, enumType, machine, field, t, action, on, require, reject, set, send, when, invariant, terminal, isIn,
  configuration, instance,
} from '@cognitive-fab/poly/embed';

export default module('shop', [
  enumType('OrderStatus', ['idle', 'pending', 'confirmed', 'rejected', 'cancelling', 'cancelled', 'expired']),

  machine('Inventory', {
    service: true,
    state: {
      available: field(t.range(0, 3), () => 1),
      reserved: field(t.range(0, 3), () => 0),
      open: field(t.bool, () => true),
    },
    items: [
      action('Restock', {}),
      action('Close', {}),
      action('Open', {}),
      action('Reserve', { from: t.ref('Order'), qty: t.range(1, 2) }),
      action('Release', { qty: t.range(1, 2) }),
      on('Restock', ($) => [
        require($.open, 'inventory-closed'),
        require($.available + $.reserved < 3, 'inventory-full'),
        set('available', $.available + 1),
      ]),
      on('Close', ($) => [
        require($.open, 'already-closed'),
        set('open', false),
      ]),
      on('Open', ($) => [
        require(!$.open, 'already-open'),
        set('open', true),
      ]),
      on('Reserve', ($) => [
        when($.open && $.available >= $.qty, [
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
      invariant('capacity', ($) => $.available + $.reserved <= 3),
    ],
  }),

  machine('Order', {
    state: {
      status: field(t.named('OrderStatus'), ($) => $.idle),
      qty: field(t.range(0, 2), () => 0),
      inv: field(t.ref('Inventory'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.rejected, $.cancelled, $.expired])),
      action('Place', { qty: t.int.check([1, 2], 'strict') }),
      action('Cancel', {}),
      action('Expire', {}),
      action('Reduce', {}),
      action('Reserved', {}),
      action('OutOfStock', {}),
      on('Place', ($) => [
        require($.status === $.idle, 'order-exists'),
        require($.qty >= 1 && $.qty <= 2, 'bad-quantity'),
        set('status', $.pending),
        set('qty', $.qty),
        send($.inv, 'Reserve', { from: $.self, qty: $.qty }),
      ], ['qty']),
      on('Cancel', ($) => [
        require($.status !== $.idle, 'unknown-order'),
        require($.status !== $.cancelling, 'already-cancelling'),
        require($.status !== $.cancelled, 'already-cancelled'),
        require($.status !== $.rejected, 'order-rejected'),
        require($.status !== $.expired, 'order-expired'),
        when($.status === $.confirmed, [
          set('status', $.cancelled),
          send($.inv, 'Release', { qty: $.qty }),
        ], [
          set('status', $.cancelling),
        ]),
      ]),
      on('Expire', ($) => [
        require($.status === $.confirmed, 'not-confirmed'),
        set('status', $.expired),
        send($.inv, 'Release', { qty: $.qty }),
      ]),
      on('Reduce', ($) => [
        require($.status === $.confirmed, 'not-confirmed'),
        require($.qty === 2, 'single-unit'),
        set('qty', 1),
        send($.inv, 'Release', { qty: 1 }),
      ]),
      on('Reserved', ($) => [
        when($.status === $.pending, [
          set('status', $.confirmed),
        ], [
          when($.status === $.cancelling, [
            set('status', $.cancelled),
            send($.inv, 'Release', { qty: $.qty }),
          ], [
            reject('not-waiting'),
          ]),
        ]),
      ]),
      on('OutOfStock', ($) => [
        when($.status === $.pending, [
          set('status', $.rejected),
        ], [
          when($.status === $.cancelling, [
            set('status', $.cancelled),
          ], [
            reject('not-waiting'),
          ]),
        ]),
      ]),
    ],
  }),

  configuration('two-orders', {
    instances: [
      instance('inv', 'Inventory'),
      instance('order', 'Order', { count: 2, init: ($) => ({ inv: $.inv }) }),
    ],
    inputs: ['order[*].Place', 'order[*].Cancel', 'order[*].Expire', 'inv.Restock', 'inv.Close', 'inv.Open'],
    bounds: { transit: 4 },
    properties: [
      invariant('within-capacity', ($) => $.inv.available + $.inv.reserved <= 3),
    ],
  }),
]);
