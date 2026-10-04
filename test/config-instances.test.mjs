// S141, S153 (M5b step 15): instances started from a configuration's initial values, and the end-to-end runtime test of
// a cross-scope send between configuration instances (S160). Both need polyrun to create an instance at given initial
// values, engine change E5, which is not vendored. They are listed as waiting, never passed.
import { test } from 'node:test';

test('S153: rt.createFrom(configuration) creates each instance at its certified initial values, and its witnesses walk through it', { todo: 'waiting on E5 (polyrun create at given initial values, S141, S153)' }, () => {});
test('S160: a cross-scope send between configuration instances is proposed, denied and answered with SendDenied, end to end', { todo: 'waiting on E5: the runtime has no configuration instances before S153' }, () => {});
