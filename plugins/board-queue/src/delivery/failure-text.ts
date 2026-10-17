import { BoardQueueError } from '../domain/errors.ts';
import { redactSecrets } from '../infrastructure/redaction.ts';

/**
 * What a person is told when something failed.
 *
 * A refusal this system has a name for says its own sentence; anything else says
 * its message and nothing more. No stack ever leaves a delivery mechanism: it
 * describes this package's insides rather than what the caller has to do, and the
 * log file already holds it.
 *
 * Whatever the sentence is, it goes out redacted. Most of them are written here
 * and quote nothing, but an error thrown by a library — a file read, a JSON
 * parse, a fetch — can carry a header or a key it happened to be handling, and
 * this is the last place before it reaches a terminal or a session.
 */
export function sentenceOf(error: unknown): string {
  return redactSecrets(sentence(error));
}

function sentence(error: unknown): string {
  if (error instanceof BoardQueueError) {
    return error.describe();
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'the reason was not stated';
}
