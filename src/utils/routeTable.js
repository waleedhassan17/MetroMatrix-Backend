/**
 * Flatten an Express 4 app into [{ method, path, middleware: [names] }].
 *
 * Used by scripts/dump-routes.js (docs/ROUTES.json + drift check) and by the
 * admin route-guard test, which asserts every admin mutation carries a named
 * permission guard. Middleware names are function names, so guards must be
 * named functions (see requirePermission in middleware/authMiddleware.js).
 *
 * Only middleware registered on routers (router.use / per-route handlers) and
 * app-level middleware mounted on a specific path is listed; global app-level
 * middleware (helmet, cors, body parsers…) applies to every route and would
 * only add noise.
 */

const METHODS_ORDER = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// Rebuild a mount path from the regexp Express compiled it to.
function mountPathOf(layer) {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  let src = layer.regexp.source;
  src = src.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\(\?=\\\/\|\$\)$/, '');
  let keyIndex = 0;
  src = src.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, () => `:${layer.keys?.[keyIndex++]?.name ?? 'param'}`);
  return src.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
}

// express-async-handler names every wrapper "asyncUtilWrap"; controllers wrapped
// that way are just handlers. Guards are named explicitly (utils/named.js).
const nameOf = (fn) => {
  const name = (fn && fn.name) || 'anonymous';
  return name === 'asyncUtilWrap' ? 'asyncHandler' : name;
};

const routePaths = (route) => (Array.isArray(route.path) ? route.path : [route.path]).map(String);

// `inherited` = names of middleware that already applies (from parent routers).
function walk(stack, prefix, inherited, out, isAppLevel) {
  const active = []; // { mount, name } of router.use() middleware seen so far
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m] && m !== '_all')
        .map((m) => m.toUpperCase());
      for (const p of routePaths(layer.route)) {
        const fullPath = `${prefix}${p}`.replace(/\/{2,}/g, '/') || '/';
        const applicable = active.filter((a) => !a.mount || fullPath.startsWith(a.mount)).map((a) => a.name);
        const handlers = layer.route.stack.map((s) => nameOf(s.handle));
        for (const method of methods) {
          out.push({ method, path: fullPath, middleware: [...inherited, ...applicable, ...handlers] });
        }
      }
      continue;
    }

    const mount = mountPathOf(layer);
    if (layer.handle && Array.isArray(layer.handle.stack)) {
      // A nested router.
      const applicable = active.filter((a) => !a.mount || `${prefix}${mount}`.startsWith(a.mount)).map((a) => a.name);
      walk(layer.handle.stack, `${prefix}${mount}`, [...inherited, ...applicable], out, false);
      continue;
    }

    // Plain middleware: global app-level middleware is skipped (see header).
    if (isAppLevel && !mount) continue;
    active.push({ mount: mount ? `${prefix}${mount}` : '', name: nameOf(layer.handle) });
  }
}

function routeTable(app) {
  const out = [];
  walk(app._router.stack, '', [], out, true);
  const rank = (m) => (METHODS_ORDER.indexOf(m) + 1 || 99);
  // Keep registration order within a path (it decides which handler wins),
  // but group by path for readable diffs.
  return out
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => a.path.localeCompare(b.path) || rank(a.method) - rank(b.method) || a.i - b.i)
    .map(({ i, ...r }) => r);
}

module.exports = { routeTable, mountPathOf };
