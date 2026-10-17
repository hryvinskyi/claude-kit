#!/usr/bin/env node
import { runCli } from '../src/delivery/cli.ts';

/**
 * The queue on a command line.
 *
 * Everything this entry point does is hand the words over and pass the verdict
 * back to the shell: nothing wrong, a command used wrongly, or a refusal. The
 * command itself has already said what happened, in one line, on the right
 * stream.
 */
process.exitCode = await runCli(process.argv.slice(2));
