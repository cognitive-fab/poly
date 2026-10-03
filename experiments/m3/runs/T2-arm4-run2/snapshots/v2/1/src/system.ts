// Orders and inventory: an inventory and orders that talk only by messages.
import {
  module, enumType, machine, field, t, action, on, require, reject, set, send, when, terminal, invariant, isIn,
  configuration, instance, count, implies, is, liveness, ALL,
} from '@cognitive-fab/poly/embed';

export default module('shop', [
  enumType('Status', ['fresh', 'pending', 'confirmed', 'rejected', 'cancelling', 'cancelled', 'expired']),

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
      ]),
      on('Release', ($) => [
        require($.reserved >= $.qty, 'not-reserved'),
        set('reserved', $.reserved - $.qty),
        set('available', $.available + $.qty),
      ]),
      invariant('holds-at-most-3', ($) => $.available + $.reserved <= 3),
    ],
  }),

  machine('Order', {
    state: {
      status: field(t.named('Status'), ($) => $.fresh),
      qty: field(t.range(0, 2), () => 0),
      inv: field(t.ref('Inventory'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.rejected, $.cancelled, $.expired])),
      action('Place', { qty: t.range(1, 2) }),
      action('Cancel', {}),
      action('Expire', {}),
      action('Reserved', {}),
      action('OutOfStock', {}),
      on('Place', ($) => [
        require($.qty >= 1 && $.qty <= 2, 'bad-quantity'),
        require($.status === $.fresh, 'order-exists'),
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
      on('Expire', ($) => [
        require($.status === $.confirmed, 'not-confirmed'),
        set('status', $.expired),
        send($.inv, 'Release', { qty: $.qty }),
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
        when($.status === $.pending, [set('status', $.rejected)], [set('status', $.cancelled)]),
      ]),
      invariant('placed-has-qty', ($) => implies($.status !== $.fresh, $.qty >= 1)),
    ],
  }),

  configuration('shop-two-orders', {
    instances: [
      instance('inv', 'Inventory'),
      instance('order', 'Order', { count: 2, init: ($) => ({ inv: $.inv }) }),
    ],
    inputs: ['order[*].Place', 'order[*].Cancel', 'order[*].Expire','inv.Restock'],
    bounds: { transit: 4 },
    properties: [
      invariant('within-capacity', ($) => $.inv.available + $.inv.reserved <= 3),
      invariant('confirmed-are-reserved', ($) => count(is($.order[ALL], 'confirmed')) <= $.inv.reserved),
      liveness('cancel-settles', { from: ($) => is($.order[$.i], 'cancelling'), to: ($) => is($.order[$.i], 'cancelled') }, { forall: ['i', 'order'] }),
    ],
  }),
]);
