#!/usr/bin/env node
import { AbletonMcpServer } from './server.js';

async function main() {
  const server = new AbletonMcpServer();
  await server.start();
}

main().catch((err) => {
  console.error('[AbletonMcpServer] Fatal startup error:', err);
  process.exit(1);
});
