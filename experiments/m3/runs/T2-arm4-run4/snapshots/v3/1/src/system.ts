// Orders and inventory: an inventory service and orders that reserve units from it by messages.
import {
  module, enumType, machine, field, t, action, on, require, set, send, when, terminal, invariant,
  configuration, instance, isIn, implies, sum, ALL,
} from '@cognitive-fab/poly/embed';

export default module('shop', [
  // `fresh` is an order instance that has not taken Place yet; the host never shows it.
  enumType('Status', ['fresh', 'pending', 'confirmed', 'rejected', 'cancelling', 'cancelled', 'expired']),

  machine('Inventory', {
    service: true,
    state: {
      available: field(t.range(0, 3), () => 1),
      reserved: field(t.range(0, 3), () => 0),
      // false while the inventory is closed for a stocktake
      open: field(t.bool, () => true),
    },
    items: [
      action('Restock', {}),
      action('Close', {}),
      action('Open', {}),
      action('Reserve', { from: t.ref('Order'), qty: t.range(1, 2) }),
      action('Release', { qty: t.range(1, 2) }),
      on('Close', ($) => [require($.open, 'closed'), set('open', false)]),
      on('Open', ($) => [require(!$.open, 'open'), set('open', true)]),
      on('Restock', ($) => [
        require($.open, 'closed'),
        require($.available + $.reserved < 3, 'inventory-full'),
        set('available', $.available + 1),
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
      status: field(t.named('Status'), ($) => $.fresh),
      qty: field(t.range(0, 2), () => 0),
      // The units this order holds at the inventory: qty while confirmed, else 0.
      held: field(t.range(0, 2), () => 0),
      inv: field(t.ref('Inventory'), ($) => $.none),
    },
    items: [
      terminal(($) => isIn($.status, [$.rejected, $.cancelled, $.expired])),
      action('Place', { qty: t.int.check([1, 2], 'strict') }),
      action('Reserved', {}),
      action('OutOfStock', {}),
      action('Cancel', {}),
      action('Expire', {}),
      on('Place', ($) => [
        require($.status === $.fresh, 'order-exists'),
        set('status', $.pending),
        set('qty', $.qty),
        send($.inv, 'Reserve', { from: $.self, qty: $.qty }),
      ], ['qty']),
      on('Reserved', ($) => [
        require(isIn($.status, [$.pending, $.cancelling]), 'not-waiting'),
        when($.status === $.pending, [
          set('status', $.confirmed),
          set('held', $.qty),
        ], [
          set('status', $.cancelled),
          send($.inv, 'Release', { qty: $.qty }),
        ]),
      ]),
      on('OutOfStock', ($) => [
        require(isIn($.status, [$.pending, $.cancelling]), 'not-waiting'),
        when($.status === $.pending, [set('status', $.rejected)], [set('status', $.cancelled)]),
      ]),
      on('Cancel', ($) => [
        require(isIn($.status, [$.pending, $.confirmed]), 'not-cancellable'),
        when($.status === $.confirmed, [
          set('status', $.cancelled),
          set('held', 0),
          send($.inv, 'Release', { qty: $.qty }),
        ], [
          set('status', $.cancelling),
        ]),
      ]),
      on('Reduce', ($) => [
        require($.status === $.confirmed, 'not-confirmed'),
        require($.qty === 2, 'not-two'),
        set('qty', 1),
        set('held', 1),
        send($.inv, 'Release', { qty: 1 }),
      ]),
      on('Expire', ($) => [
        require($.status === $.confirmed, 'not-confirmed'),
        set('status', $.expired),
        set('held', 0),
        send($.inv, 'Release', { qty: $.qty }),
      ]),
      invariant('held-when-confirmed', ($) => implies($.status === $.confirmed, $.held === $.qty && $.held > 0)),
      invariant('held-only-confirmed', ($) => implies($.status !== $.confirmed, $.held === 0)),
    ],
  }),

  configuration('shop', {
    instances: [
      instance('inv', 'Inventory'),
      instance('order', 'Order', { count: 2, init: ($) => ({ inv: $.inv }) }),
    ],
    inputs: ['order[*].Place', 'order[*].Cancel', 'order[*].Expire','inv.Restock', 'inv.Close', 'inv.Open'],
    bounds: { transit: 4 },
    properties: [
      invariant('confirmed-are-reserved', ($) => sum($.order[ALL].held) <= $.inv.reserved),
    ],
  }),
]);
