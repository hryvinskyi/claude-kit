/**
 * The one place that knows what a credential looks like.
 *
 * Everything this package writes outwards — a log line, the sentence inside an
 * error, the columns a queue row keeps — passes through here first, so a
 * credential that reached a string by accident (a transport error that quoted a
 * request, a payload echoed back, an environment file read into a message) still
 * never reaches a file or a queue row.
 */

/**
 * GitHub's token shapes, the coordination server's, the three-part JWT an App
 * signs to mint one, a private key in the form a file holds it, and the header any
 * of them travels in.
 *
 * The key block is matched with `[\s\S]` rather than with a newline class so that
 * a key whose line breaks were written as the two characters `\` and `n` — the
 * way a key pasted into an environment variable arrives — is caught by the same
 * shape as one that still has its real newlines.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_\w+/g,
  /\bdibs_[A-Za-z0-9_-]{32,128}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const shape of SECRET_SHAPES) {
    redacted = redacted.replace(shape, '[redacted]');
  }
  return redacted;
}
