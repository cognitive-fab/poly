// Name mapping for a run outside a container (DB6 item 3), preloaded into the build under test by NODE_OPTIONS=--require. The build
// believes it talks to api.stripe.com and graph.facebook.com; this sends those two names to the stand-in's port on the loopback and
// refuses every other destination that is not the loopback, so a bug in the build cannot reach an outside host. The name stays the
// connection's server name, so the build verifies the stand-in's certificate against api.stripe.com, as it would against the real one,
// through the authority NODE_EXTRA_CA_CERTS names. In a container the same mapping is done by name resolution, and this file is not used.
const net = require('node:net');

const port = Number(process.env.POLY_DEMO_STANDIN_PORT);
const mapped = new Set((process.env.POLY_DEMO_STANDIN_NAMES || 'api.stripe.com,graph.facebook.com').split(','));
if (!port) throw new Error('POLY_DEMO_STANDIN_PORT is not set: the stand-in\'s port');

const isLoopback = (h) => h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
const original = net.Socket.prototype.connect;

net.Socket.prototype.connect = function connect(...args) {
  const normalized = net._normalizeArgs(args);
  const options = normalized[0];
  if (options.path) return original.apply(this, args); // a local socket
  const host = String(options.host || 'localhost').toLowerCase();
  if (mapped.has(host)) {
    options.host = '127.0.0.1';
    options.port = port;
    return original.call(this, options, normalized[1]);
  }
  if (isLoopback(host)) return original.apply(this, args);
  // Not the stand-in and not the machine: no route (the container's rule, kept outside it).
  process.nextTick(() => this.destroy(Object.assign(new Error(`connect ECONNREFUSED ${host}:${options.port}: no route outside the demo`), { code: 'ECONNREFUSED' })));
  return this;
};
