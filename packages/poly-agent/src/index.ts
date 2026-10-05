// poly's agent interface (S167): host-neutral servers over the command registry, which this package re-exports.
export { COMMANDS, NOT_BUILT, commandNamed, CommandUsageError, type Command, type Outcome, type Schema } from '@poly/check';
export { serveMcp, mcpTools, type McpOptions } from './mcp.js';
export { serveLsp, toLsp, type LspOptions } from './lsp.js';
