// The host side of a flash block (docs/examples/flash-controller.md): it writes a value to one block against a device and tells
// the machine what the device did. It holds no rule; the machine does (erase before program, the retry limit). Typed against the
// generated types of the block, so a wrong action or field is a finding of `poly check --host` (PL6836).
import type { Action } from '../.poly/build/flash.Block/types.js';

export type Answer = 'ok' | 'fail';

export interface Device {
  program(value: number): Promise<Answer>;
  verify(): Promise<Answer>;
  erase(): Promise<Answer>;
}

interface Runtime {
  dispatch<A>(id: string, action: A extends { action: infer N } ? N & string : string, data: A extends { data: infer D } ? D : unknown): Promise<unknown>;
  getState(id: string): Promise<{ state: Record<string, unknown> }>;
}

type Name = Action['action'];
const send = (rt: Runtime, id: string, name: Name, data: Record<string, unknown> = {}) => rt.dispatch<Action>(id, name as never, data as never);

/** Writes `value` to the block until it is Verified or Bad, and returns its final state. */
export async function driveBlock(rt: Runtime, id: string, device: Device, value: 0 | 1 | 2 | 3): Promise<Record<string, unknown>> {
  for (;;) {
    await send(rt, id, 'Program', { value });
    await send(rt, id, (await device.program(value)) === 'ok' ? 'ProgramDone' : 'ProgramFailed');
    await send(rt, id, 'Verify');
    if ((await device.verify()) === 'ok') {
      await send(rt, id, 'VerifyPassed');
      return (await rt.getState(id)).state;
    }
    await send(rt, id, 'VerifyFailed');
    const state = (await rt.getState(id)).state;
    if (state.state === 'Bad') return state;
    // The block is Erasing: the device erases it and the machine is told.
    if ((await device.erase()) === 'ok') await send(rt, id, 'EraseDone');
    else return (await rt.getState(id)).state;
  }
}
