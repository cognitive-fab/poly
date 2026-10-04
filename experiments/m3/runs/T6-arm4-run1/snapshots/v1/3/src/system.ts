// T6, jobs with retries and cancellation: one Job instance per job id, created by submit.
import { module, enumType, machine, field, t, action, on, require, set, when, terminal, invariant, stepProperty, implies, isIn } from '@cognitive-fab/poly/embed';

export default module('jobs', [
  enumType('Status', ['unsubmitted','queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'held']),
  machine('Job', {
    state: {
      status: field(t.named('Status'), ($) => $.unsubmitted),
      tries: field(t.range(0, 3), () => 0),
      maxTries: field(t.range(0, 3), () => 0),
    },
    items: [
      terminal(($) => isIn($.status, [$.succeeded, $.failed, $.cancelled])),
      action('Submit', { maxTries: t.int.check(0, 4, 'disclosed') }),
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
        require(isIn($.status, [$.running, $.cancelling]), 'not-running'),
        set('status', $.succeeded),
      ]),
      on('Fail', ($) => [
        require(isIn($.status, [$.running, $.cancelling]), 'not-running'),
        when($.status === $.cancelling, [set('status', $.cancelled)], [
          when($.tries < $.maxTries, [set('status', $.queued)], [set('status', $.failed)]),
        ]),
      ]),
      on('Cancel', ($) => [
        require(isIn($.status, [$.queued, $.held, $.running]), 'not-cancellable'),
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
      invariant('failed-only-after-last-try', ($) => implies($.status === $.failed, $.tries === $.maxTries)),
      stepProperty('cancel-keeps-done-work', ($) =>
        implies($.pre.status === $.cancelling && $.action === $.Succeed, $.post.status === $.succeeded)),
    ],
  }),
]);
