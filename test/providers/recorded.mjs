// A recorded decision provider (PD1.7): the effect handler for a decision kind, which answers from a list of
// recorded replies instead of calling a model. Tests use it so that no test calls a model; it is test code,
// outside every check path, and poly's packages never import it.
//
// A reply is what an adapter returns after the calibration map (PD1.6): { answer, conf, margin }, with conf
// and margin in thousandths (PD1.3a). The handler records each question it was asked.
export function recordedProvider(replies) {
  const queue = [...replies];
  const asked = [];
  const handler = async (payload) => {
    asked.push(payload);
    if (!queue.length) throw new Error('recorded provider: no reply left');
    const reply = queue.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { handler, asked };
}
