// T7: a run and its two workers, talking by messages.
import {
  module, machine, field, t, action, on, require, set, when, send, configuration, instance, implies, invariant, isIn, terminal,
} from '@cognitive-fab/poly/embed';

export default module('t7', [
  machine('Run', {
    state: {
      status: field(t.string, () => 'idle', { check: ['idle', 'running', 'cancelling', 'completed', 'failed', 'cancelled'] }),
      task0: field(t.string, () => 'idle', { check: ['idle', 'assigned', 'completed', 'failed', 'cancelled'] }),
      task1: field(t.string, () => 'idle', { check: ['idle', 'assigned', 'completed', 'failed', 'cancelled'] }),
      w0: field(t.ref('Worker'), ($) => $.none),
      w1: field(t.ref('Worker'), ($) => $.none),
    },
    items: [
      // An ended run ignores further reports.
      terminal(($) => isIn($.status, ['completed', 'failed', 'cancelled'])),
      action('Start', {}),
      action('Cancel', {}),
      action('Report', { task: t.range(0, 1), outcome: t.string.check(['completed', 'failed', 'cancelled']) }),
      on('Start', ($) => [
        require($.status === 'idle', 'already-started'),
        set('status', 'running'),
        set('task0', 'assigned'),
        set('task1', 'assigned'),
        send($.w0, 'Assign', {}),
        send($.w1, 'Assign', {}),
      ]),
      on('Cancel', ($) => [
        require($.status === 'running', 'not-running'),
        set('status', 'cancelling'),
        when($.task0 === 'assigned', [send($.w0, 'Abort', {})]),
        when($.task1 === 'assigned', [send($.w1, 'Abort', {})]),
      ]),
      // A report sets its task's status, then the run's status from both tasks' (post) statuses.
      on('Report', ($) => [
        require($.status === 'running' || $.status === 'cancelling', 'not-active'),
        when($.task === 0, [
          require($.task0 === 'assigned', 'already-reported'),
          set('task0', $.outcome),
          when($.outcome === 'completed' && $.task1 === 'completed', [set('status', 'completed')], [
            when($.task1 !== 'assigned', [
              when($.outcome === 'failed' || $.task1 === 'failed', [set('status', 'failed')], [set('status', 'cancelled')]),
            ]),
          ]),
        ], [
          require($.task1 === 'assigned', 'already-reported'),
          set('task1', $.outcome),
          when($.outcome === 'completed' && $.task0 === 'completed', [set('status', 'completed')], [
            when($.task0 !== 'assigned', [
              when($.outcome === 'failed' || $.task0 === 'failed', [set('status', 'failed')], [set('status', 'cancelled')]),
            ]),
          ]),
        ]),
      ], ['task', 'outcome']),
    ],
  }),
  machine('Worker', {
    service: true,
    state: {
      status: field(t.string, () => 'idle', { check: ['idle', 'busy'] }),
      task: field(t.range(0, 1), () => 0),
      run: field(t.ref('Run'), ($) => $.none),
    },
    items: [
      action('Assign', {}),
      action('Abort', {}),
      action('WorkDone', {}),
      action('WorkFailed', {}),
      on('Assign', ($) => [require($.status === 'idle', 'not-idle'), set('status', 'busy')]),
      // An Abort that reaches an idle worker is ignored: refused, it changes nothing.
      on('Abort', ($) => [
        require($.status === 'busy', 'not-busy'),
        set('status', 'idle'),
        send($.run, 'Report', { task: $.task, outcome: 'cancelled' }),
      ]),
      on('WorkDone', ($) => [
        require($.status === 'busy', 'not-busy'),
        set('status', 'idle'),
        send($.run, 'Report', { task: $.task, outcome: 'completed' }),
      ]),
      on('WorkFailed', ($) => [
        require($.status === 'busy', 'not-busy'),
        set('status', 'idle'),
        send($.run, 'Report', { task: $.task, outcome: 'failed' }),
      ]),
    ],
  }),
  configuration('system', {
    instances: [
      instance('run', 'Run', { init: ($) => ({ w0: $.worker0, w1: $.worker1 }) }),
      instance('worker0', 'Worker', { init: ($) => ({ run: $.run, task: 0 }) }),
      instance('worker1', 'Worker', { init: ($) => ({ run: $.run, task: 1 }) }),
    ],
    inputs: ['run.Start', 'run.Cancel', 'worker0.WorkDone', 'worker0.WorkFailed', 'worker1.WorkDone', 'worker1.WorkFailed'],
    bounds: { transit: 4 },
    properties: [
      invariant('completed-only-when-both-completed', ($) =>
        implies($.run.status === 'completed', $.run.task0 === 'completed' && $.run.task1 === 'completed')),
      invariant('ends-only-when-both-reported', ($) =>
        implies(isIn($.run.status, ['completed', 'failed', 'cancelled']), $.run.task0 !== 'assigned' && $.run.task1 !== 'assigned')),
      invariant('ended-run-has-idle-workers', ($) =>
        implies(isIn($.run.status, ['completed', 'failed', 'cancelled']), $.worker0.status === 'idle' && $.worker1.status === 'idle')),
      invariant('busy-worker-task-assigned0', ($) => implies($.worker0.status === 'busy', $.run.task0 === 'assigned')),
      invariant('busy-worker-task-assigned1', ($) => implies($.worker1.status === 'busy', $.run.task1 === 'assigned')),
    ],
  }),
]);
