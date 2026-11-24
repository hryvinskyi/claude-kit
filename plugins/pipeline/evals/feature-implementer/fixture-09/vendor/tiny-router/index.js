// tiny-router 2.1.0 — third-party. Matches a method and a path against a route table.
// A segment written `:name` in a pattern matches any one segment and is returned under that name.

/**
 * @param {Array<{ method: string, path: string, handler: string }>} routes
 * @param {string} method
 * @param {string} path
 * @returns {{ handler: string, params: Record<string, string> } | null} the first route that matches, or null
 */
export function match(routes, method, path) {
  const asked = path.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.path.split('/').filter(Boolean);
    if (pattern.length !== asked.length) continue;
    const params = {};
    let fits = true;
    for (let at = 0; at < pattern.length; at += 1) {
      if (pattern[at].startsWith(':')) {
        params[pattern[at].slice(1)] = decodeURIComponent(asked[at]);
      } else if (pattern[at] !== asked[at]) {
        fits = false;
        break;
      }
    }
    if (fits) return { handler: route.handler, params };
  }
  return null;
}
