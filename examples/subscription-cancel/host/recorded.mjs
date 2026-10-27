// The recorded services of the subscription example (docs/examples/subscription-cancel.md). The example calls no model, so
// what is recorded is the answers of the marketing and billing services: a script maps a URL to a status or a list of
// statuses (the nth request to the URL gets the nth status, the last repeating), and a URL the script does not name
// answers 201. Every request is kept, and nothing leaves the machine.

/** The fake egress transport the runtime's load takes, and the requests it saw. */
export function recordedServices(script = {}) {
  const sent = [];
  const counts = new Map();
  const egress = async (req) => {
    const n = counts.get(req.url) ?? 0;
    counts.set(req.url, n + 1);
    const planned = script[req.url];
    const status = Array.isArray(planned) ? planned[Math.min(n, planned.length - 1)] : (planned ?? 201);
    sent.push({ url: req.url, body: req.body, headers: req.headers ?? {} });
    return { status, headers: {}, body: { ok: status < 300 } };
  };
  return { sent, transports: { egress } };
}
