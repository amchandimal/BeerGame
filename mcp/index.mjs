import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBeerGameMcp } from './server.mjs';

const { server, sessions } = createBeerGameMcp();
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await sessions.dispose();
  await server.close();
}
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
const transport = new StdioServerTransport();
await server.connect(transport);
const protocolOnClose = transport.onclose;
transport.onclose = () => { protocolOnClose?.(); void shutdown(); };
process.stdin.once('end', () => { void shutdown(); });
// stdout belongs exclusively to the MCP JSON-RPC transport.
