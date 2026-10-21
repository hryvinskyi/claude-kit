import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A freshly made App key pair, the private half written where a test says, owner-only. */
export function writeAppKey(directory: string, name = 'app.pem', mode = 0o400): { path: string; publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const path = join(directory, name);
  writeFileSync(path, pair.privateKey, { mode: 0o600 });
  chmodSync(path, mode);
  return { path, publicKey: pair.publicKey, privateKey: pair.privateKey };
}
