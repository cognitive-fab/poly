// T5, workflow run status: one Run machine per run id, holding its three tasks and the derived run status.
// Every handler that changes a task re-derives the status from the tasks' new values (n0, n1, n2):
//   1. all three alike -> that status; 2. any failed -> failed; 3. any in flight -> running; 4. else cancelled.
import { module, enumType, machine, field, t, action, on, require, reject, set, let_, when, guard, terminal, invariant, implies, isIn } from '@cognitive-fab/poly/embed';

export default module('workflow', [
  enumType('Status', ['queued', 'running', 'evicted', 'completed', 'failed', 'cancelled']),
  machine('Run', {
    state: {
      status: field(t.named('Status'), ($) => $.queued),
      task0: field(t.named('Status'), ($) => $.queued),
      task1: field(t.named('Status'), ($) => $.queued),
      task2: field(t.named('Status'), ($) => $.queued),
      started: field(t.bool, () => false),
      // A paused run starts no queued task; pausing leaves the status alone.
      paused: field(t.bool, () => false),
    },
    items: [
      // A failed run can be retried, so only completed and cancelled are final for the run.
      terminal(($) => isIn($.status, [$.completed, $.cancelled])),
      guard(($) => isIn($.status, [$.completed, $.cancelled]), 'run-finished'),

      action('Start', {}),
      action('TaskStarted', { task: t.int.check(0, 2, 'strict') }),
      action('TaskCompleted', { task: t.int.check(0, 2, 'strict') }),
      action('TaskFailed', { task: t.int.check(0, 2, 'strict') }),
      action('TaskEvicted', { task: t.int.check(0, 2, 'strict') }),
      action('TaskRequeued', { task: t.int.check(0, 2, 'strict') }),
      action('TaskRetried', { task: t.int.check(0, 2, 'strict') }),
      action('Cancel', {}),
      action('CancelTask', { task: t.int.check(0, 2, 'strict') }),
      action('Pause', {}),
      action('Resume', {}),

      on('Pause', ($) => [require($.started, 'unknown-run'), require(!$.paused, 'run-paused'), set('paused', true)]),
      on('Resume', ($) => [require($.started, 'unknown-run'), require($.paused, 'run-not-paused'), set('paused', false)]),

      on('Start', ($) => [require(!$.started, 'run-exists'), set('started', true)]),

      // queued -> running
      on('TaskStarted', ($) => [
        require($.started, 'unknown-run'),
        require(!$.paused, 'run-paused'),
        when($.task === 0, [
          require($.task0 === $.queued, 'task-not-queued'),
          set('task0', $.running),
          let_('n0', $.running), let_('n1', $.task1), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 1, [
          require($.task1 === $.queued, 'task-not-queued'),
          set('task1', $.running),
          let_('n0', $.task0), let_('n1', $.running), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 2, [
          require($.task2 === $.queued, 'task-not-queued'),
          set('task2', $.running),
          let_('n0', $.task0), let_('n1', $.task1), let_('n2', $.running),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [reject('no-such-task')])])]),
      ], ['task']),

      // running -> completed
      on('TaskCompleted', ($) => [
        require($.started, 'unknown-run'),
        when($.task === 0, [
          require($.task0 === $.running, 'task-not-running'),
          set('task0', $.completed),
          let_('n0', $.completed), let_('n1', $.task1), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 1, [
          require($.task1 === $.running, 'task-not-running'),
          set('task1', $.completed),
          let_('n0', $.task0), let_('n1', $.completed), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 2, [
          require($.task2 === $.running, 'task-not-running'),
          set('task2', $.completed),
          let_('n0', $.task0), let_('n1', $.task1), let_('n2', $.completed),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [reject('no-such-task')])])]),
      ], ['task']),

      // running -> failed
      on('TaskFailed', ($) => [
        require($.started, 'unknown-run'),
        when($.task === 0, [
          require($.task0 === $.running, 'task-not-running'),
          set('task0', $.failed),
          let_('n0', $.failed), let_('n1', $.task1), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 1, [
          require($.task1 === $.running, 'task-not-running'),
          set('task1', $.failed),
          let_('n0', $.task0), let_('n1', $.failed), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 2, [
          require($.task2 === $.running, 'task-not-running'),
          set('task2', $.failed),
          let_('n0', $.task0), let_('n1', $.task1), let_('n2', $.failed),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [reject('no-such-task')])])]),
      ], ['task']),

      // running -> evicted
      on('TaskEvicted', ($) => [
        require($.started, 'unknown-run'),
        when($.task === 0, [
          require($.task0 === $.running, 'task-not-running'),
          set('task0', $.evicted),
          let_('n0', $.evicted), let_('n1', $.task1), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 1, [
          require($.task1 === $.running, 'task-not-running'),
          set('task1', $.evicted),
          let_('n0', $.task0), let_('n1', $.evicted), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 2, [
          require($.task2 === $.running, 'task-not-running'),
          set('task2', $.evicted),
          let_('n0', $.task0), let_('n1', $.task1), let_('n2', $.evicted),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [reject('no-such-task')])])]),
      ], ['task']),

      // evicted -> queued
      on('TaskRequeued', ($) => [
        require($.started, 'unknown-run'),
        when($.task === 0, [
          require($.task0 === $.evicted, 'task-not-evicted'),
          set('task0', $.queued),
          let_('n0', $.queued), let_('n1', $.task1), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 1, [
          require($.task1 === $.evicted, 'task-not-evicted'),
          set('task1', $.queued),
          let_('n0', $.task0), let_('n1', $.queued), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 2, [
          require($.task2 === $.evicted, 'task-not-evicted'),
          set('task2', $.queued),
          let_('n0', $.task0), let_('n1', $.task1), let_('n2', $.queued),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [reject('no-such-task')])])]),
      ], ['task']),

      // failed -> queued
      on('TaskRetried', ($) => [
        require($.started, 'unknown-run'),
        when($.task === 0, [
          require($.task0 === $.failed, 'task-not-failed'),
          set('task0', $.queued),
          let_('n0', $.queued), let_('n1', $.task1), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 1, [
          require($.task1 === $.failed, 'task-not-failed'),
          set('task1', $.queued),
          let_('n0', $.task0), let_('n1', $.queued), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 2, [
          require($.task2 === $.failed, 'task-not-failed'),
          set('task2', $.queued),
          let_('n0', $.task0), let_('n1', $.task1), let_('n2', $.queued),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [reject('no-such-task')])])]),
      ], ['task']),

      // in flight -> cancelled, for one task
      on('CancelTask', ($) => [
        require($.started, 'unknown-run'),
        when($.task === 0, [
          require(isIn($.task0, [$.queued, $.running, $.evicted]), 'task-not-in-flight'),
          set('task0', $.cancelled),
          let_('n0', $.cancelled), let_('n1', $.task1), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 1, [
          require(isIn($.task1, [$.queued, $.running, $.evicted]), 'task-not-in-flight'),
          set('task1', $.cancelled),
          let_('n0', $.task0), let_('n1', $.cancelled), let_('n2', $.task2),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [when($.task === 2, [
          require(isIn($.task2, [$.queued, $.running, $.evicted]), 'task-not-in-flight'),
          set('task2', $.cancelled),
          let_('n0', $.task0), let_('n1', $.task1), let_('n2', $.cancelled),
          when($.n0 === $.n1 && $.n1 === $.n2, [set('status', $.n0)], [
            when($.n0 === $.failed || $.n1 === $.failed || $.n2 === $.failed, [set('status', $.failed)], [
              when(isIn($.n0, [$.queued, $.running, $.evicted]) || isIn($.n1, [$.queued, $.running, $.evicted]) || isIn($.n2, [$.queued, $.running, $.evicted]),
                [set('status', $.running)], [set('status', $.cancelled)])])]),
        ], [reject('no-such-task')])])]),
      ], ['task']),

      // Every task in flight becomes cancelled. No task is left in flight, and no two tasks can be alike unless
      // both are final, so the status is failed when a task failed, and cancelled otherwise.
      on('Cancel', ($) => [
        require($.started, 'unknown-run'),
        require(isIn($.task0, [$.queued, $.running, $.evicted]) || isIn($.task1, [$.queued, $.running, $.evicted]) || isIn($.task2, [$.queued, $.running, $.evicted]), 'nothing-in-flight'),
        when(isIn($.task0, [$.queued, $.running, $.evicted]), [set('task0', $.cancelled)]),
        when(isIn($.task1, [$.queued, $.running, $.evicted]), [set('task1', $.cancelled)]),
        when(isIn($.task2, [$.queued, $.running, $.evicted]), [set('task2', $.cancelled)]),
        when($.task0 === $.failed || $.task1 === $.failed || $.task2 === $.failed, [set('status', $.failed)], [set('status', $.cancelled)]),
      ]),

      // The conclusion of the brief: the status never hides a task.
      invariant('completed-only-when-all-completed', ($) =>
        implies($.status === $.completed, $.task0 === $.completed && $.task1 === $.completed && $.task2 === $.completed)),
      invariant('failed-whenever-a-task-failed', ($) =>
        implies($.task0 === $.failed || $.task1 === $.failed || $.task2 === $.failed, $.status === $.failed)),
      invariant('not-final-while-in-flight', ($) =>
        implies(isIn($.task0, [$.queued, $.running, $.evicted]) || isIn($.task1, [$.queued, $.running, $.evicted]) || isIn($.task2, [$.queued, $.running, $.evicted]),
          !isIn($.status, [$.completed, $.cancelled]))),
    ],
  }),
]);
