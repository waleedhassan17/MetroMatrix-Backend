// Give a middleware function a stable name. Wrappers such as
// express-async-handler and express-rate-limit return anonymous functions,
// and the route table (src/utils/routeTable.js) — and the admin route-guard
// test built on it — identify guards by name.
module.exports = (name, fn) => Object.defineProperty(fn, 'name', { value: name, configurable: true });
