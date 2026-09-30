// The OMS order's cross-machine invariants, written by hand for polyrun's check-product (S27). They are
// committed before any poly OMS source exists, so the poly compose invariants are written to state these
// predicates, not the other way round. The joint state is check-product's:
//   { parent: { state, status }, children: { [childKey]: { state, status, … } } }

const shipments = (joint) => Object.values(joint.children);

export const stateInvariants = [
  // A completed order has as many delivered shipments as it has fulfillments.
  {
    name: 'completed-has-every-shipment-delivered',
    pred: (joint) => joint.parent.state.orderState !== 'completed'
      || shipments(joint).filter((c) => c.state.shipState === 'delivered').length === joint.parent.state.fulfillments,
  },
  // No shipment is spawned before the order is charged.
  {
    name: 'no-shipment-before-charge',
    pred: (joint) => shipments(joint).length === 0 || joint.parent.state.txId !== '',
  },
];

export const transitionInvariants = [];
