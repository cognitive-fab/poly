// Jobs with retries and cancellation: one Job instance per job id, created by submit.
import { module, enumType, machine, field, t, action, on, require, set, when, terminal, invariant, stepProperty, implies, isIn } from '@cognitive-fab/poly/embed';

export default module('jobs', [
  enumType('Status', ['unsubmitted', 'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'held']),
  machine('Job', {
    state: {
      status: field(t.named('Status'), ($) => $.unsubmitted),
      tries: field(t.range(0, 3), () => 0),
      maxTries: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.succeeded, $.failed, $.cancelled])),
      action('Submit', { maxTries: t.int.check(1, 3, 'strict') }),
      action('Claim', {}),
      action('Succeed', {}),
      action('Fail', {}),
      action('Lost', {}),
      action('Cancel', {}),
      action('Hold', {}),
      action('Release', {}),
      on('Hold', ($) => [require($.status === $.queued, 'not-queued'), set('status', $.held)]),
      on('Release', ($) => [require($.status === $.held, 'not-held'), set('status', $.queued)]),
      on('Submit', ($) => [
        require($.status === $.unsubmitted, 'job-exists'),
        set('status', $.queued),
        set('maxTries', $.maxTries),
      ], ['maxTries']),
      on('Claim', ($) => [
        require($.status === $.queued, 'not-queued'),
        require($.tries < $.maxTries, 'no-tries-left'),
        set('status', $.running),
        set('tries', $.tries + 1),
      ]),
      on('Succeed', ($) => [
        require($.status === $.running || $.status === $.cancelling, 'not-running'),
        set('status', $.succeeded),
      ]),
      on('Fail', ($) => [
        require($.status === $.running || $.status === $.cancelling, 'not-running'),
        when($.status === $.cancelling, [set('status', $.cancelled)], [
          when($.tries < $.maxTries, [set('status', $.queued)], [set('status', $.failed)]),
        ]),
      ]),
      on('Lost', ($) => [
        require($.status === $.running || $.status === $.cancelling, 'not-running'),
        when($.status === $.cancelling, [set('status', $.cancelled)], [
          when($.tries < $.maxTries, [set('status', $.queued)], [set('status', $.failed)]),
        ]),
      ]),
      on('Cancel', ($) => [
        require($.status === $.queued || $.status === $.held || $.status === $.running, 'not-cancellable'),
        when($.status === $.running, [set('status', $.cancelling)], [set('status', $.cancelled)]),
      ]),
      invariant('tries-within-limit', ($) => $.tries <= $.maxTries),
      invariant('failed-used-all-tries', ($) => implies($.status === $.failed, $.tries === $.maxTries)),
      invariant('submitted-has-limit', ($) => implies($.status !== $.unsubmitted, $.maxTries >= 1)),
      stepProperty('failed-from-running', ($) => implies($.post.status === $.failed && $.pre.status !== $.failed, $.pre.status === $.running)),
      stepProperty('cancelled-not-after-success', ($) => implies($.post.status === $.cancelled && $.pre.status !== $.cancelled, isIn($.pre.status, [$.queued, $.held, $.cancelling]))),
    ],
  }),
]);
