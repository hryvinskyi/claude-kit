import { createApp } from '../../src/app.js';

/** A started application whose clock stands at nine in the morning of 10 March 2026. */
export async function boot() {
  return createApp({ clock: { now: () => new Date('2026-03-10T09:00:00Z') } });
}

/** A parcel as a clerk types it in. */
export const typed = (changes = {}) => ({ id: 'P-1', weight: 2, longestSide: 30, postcode: 'ab1 2cd', ...changes });

/** Send a request with the application's own session token, as a signed-in browser does. */
export function send(app, method, path, { body, role = 'clerk', language = 'en' } = {}) {
  return app.handle({ method, path, body, role, language, token: app.token });
}
