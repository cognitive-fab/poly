// T6, jobs with retries and cancellation: one Job machine per job id, created by submit.
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
      action('Submit', { maxTries: t.int.check([1, 2, 3], 'strict') }),
      action('Claim', {}),
      action('Succeed', {}),
      action('Fail', {}),
      action('Cancel', {}),
      action('Hold', {}),
      action('Release', {}),
      on('Submit', ($) => [
        require($.status === $.unsubmitted, 'job-exists'),
        require($.maxTries >= 1 && $.maxTries <= 3, 'max-tries-out-of-range'),
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
      on('FailPermanently', ($) => [
        require($.status === $.running || $.status === $.cancelling, 'not-running'),
        when($.status === $.cancelling, [set('status', $.cancelled)], [set('status', $.failed)]),
      ]),
      on('Cancel', ($) => [
        require($.status === $.queued || $.status === $.held || $.status === $.running, 'not-cancellable'),
        when($.status === $.running, [set('status', $.cancelling)], [set('status', $.cancelled)]),
      ]),
      on('Hold', ($) => [
        require($.status === $.queued, 'not-queued'),
        set('status', $.held),
      ]),
      on('Release', ($) => [
        require($.status === $.held, 'not-held'),
        set('status', $.queued),
      ]),
      invariant('tries-within-limit', ($) => $.tries <= $.maxTries),
      invariant('queued-has-tries-left', ($) => implies($.status === $.queued || $.status === $.held, $.tries < $.maxTries)),
      invariant('failed-used-all-tries', ($) => implies($.status === $.failed, $.tries === $.maxTries)),
      stepProperty('cancel-keeps-done-work', ($) =>
        implies($.pre.status === $.cancelling, isIn($.post.status, [$.cancelling, $.succeeded, $.cancelled]))),
    ],
  }),
]);
