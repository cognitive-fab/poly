// Public surface. Reach past this file only from inside the package.
export { Polyaxion, EngineError, renderRecall } from './engine.mjs';
export { Store, GENESIS, entryHash } from './store/store.mjs';
export { attach, GateClient, loadConfig, portForProject, declareConfiguredPolicies, probe } from './daemon.mjs';
export { serve } from './mcp/server.mjs';
export { makeTools, INSTRUCTIONS } from './mcp/tools.mjs';
export { handleHook, HOOK_EVENTS } from './mounts/claude-code/hook.mjs';
export { extractActions, classifyCommand, splitChain } from './mounts/claude-code/extract.mjs';
export { install, uninstall, hookWiring, STARTER_POLICY } from './mounts/claude-code/install.mjs';
export { compileToTriple, writeTriple, readTriple } from './compile/index.mjs';
export { admitPolicy } from './admission.mjs';
export { Gate, compositeDoc } from './runtime/gate.mjs';
export { wrapMcp, wrapVercel } from './mounts/sdk.mjs';
export * as core from './core/index.mjs';
