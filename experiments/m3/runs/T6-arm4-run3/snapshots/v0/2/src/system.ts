// T6, jobs with retries and cancellation: one Job machine per job id, created by submit.
import { module, enumType, machine, field, t, action, on, require, set, when, terminal, invariant, stepProperty, implies, isIn } from '@cognitive-fab/poly/embed';

export default module('jobs', [
  enumType('Status', ['unsubmitted', 'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled']),
  machine('Job', {
    state: {
      status: field(t.named('Status'), ($) => $.unsubmitted),
      tries: field(t.range(0, 3), () => 0),
      maxTries: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.succeeded, $.failed, $.cancelled])),
      action('Submit', { max: t.int.check(0, 4) }),
      action('Claim', {}),
      action('Succeed', {}),
      action('Fail', {}),
      action('Cancel', {}),
      on('Submit', ($) => [
        require($.status === $.unsubmitted, 'job-exists'),
        require($.max >= 1 && $.max <= 3, 'max-tries-out-of-range'),
        set('status', $.queued),
        set('maxTries', $.max),
      ], ['max']),
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
      on('Cancel', ($) => [
        require($.status === $.queued || $.status === $.running, 'not-cancellable'),
        when($.status === $.queued, [set('status', $.cancelled)], [set('status', $.cancelling)]),
      ]),
      invariant('tries-within-limit', ($) => $.tries <= $.maxTries),
      invariant('queued-has-tries-left', ($) => implies($.status === $.queued, $.tries < $.maxTries)),
      invariant('failed-used-all-tries', ($) => implies($.status === $.failed, $.tries === $.maxTries)),
      stepProperty('cancelled-only-from-queued-or-cancelling', ($) =>
        implies($.post.status === $.cancelled && $.pre.status !== $.cancelled, $.pre.status === $.queued || $.pre.status === $.cancelling)),
      stepProperty('succeeded-only-by-worker', ($) =>
        implies($.post.status === $.succeeded && $.pre.status !== $.succeeded, $.pre.status === $.running || $.pre.status === $.cancelling)),
    ],
  }),
]);
