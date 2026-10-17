#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildContainer } from '../src/delivery/container.ts';
import { sentenceOf } from '../src/delivery/failure-text.ts';
import { createMcpServer } from '../src/delivery/mcp-server.ts';
import { loadConfig } from '../src/infrastructure/config-file.ts';
import { stateDir } from '../src/infrastructure/paths.ts';

/**
 * The queue's tools, spoken over this process's own input and output.
 *
 * That output stream is the protocol: nothing here prints, and everything worth
 * recording goes to the log file in the state directory. A failure before the
 * connection is made is the one thing said out loud, on the error stream, because
 * a session that starts this and gets silence has nothing else to go on.
 */
async function main(): Promise<void> {
  const container = buildContainer({ config: loadConfig(), stateDir: stateDir() });
  container.logger.info('the queue tools are answering', { stateDir: container.stateDir });
  await createMcpServer(container).connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`board-queue could not start: ${sentenceOf(error)}\n`);
  process.exitCode = 1;
});
