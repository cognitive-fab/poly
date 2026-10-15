// A mutant stand-in (DAC8, DAC9): Stripe's behaviour with Idempotency-Key broken, so that every request is applied whatever key it
// carries. It exists to show that a control fails where it should: the stand-in's own key check must catch it, and the driver must
// refuse to report any build against it.
import { createStripe } from '../../../../demo/stand-in/stripe/stripe.mjs';

export function createStripeIgnoringKeys(options) {
  const real = createStripe(options);
  return {
    ...real,
    handle(request) {
      const { 'idempotency-key': _ignored, ...headers } = request.headers ?? {};
      return real.handle({ ...request, headers });
    },
  };
}
