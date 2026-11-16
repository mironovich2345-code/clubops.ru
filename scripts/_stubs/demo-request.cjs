// Test-only request boundary. Business auth/session/scope/database stay real.
const { AsyncLocalStorage } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
exports.run = (store, fn) => storage.run(store, fn);
exports.cookies = async () => {
  const map = storage.getStore();
  if (!map) throw new Error('QA request context missing');
  return {
    get: name => map.has(name) ? { name, value: map.get(name) } : undefined,
    set: (name, value) => map.set(name, value),
    delete: name => map.delete(name),
    getAll: () => [...map].map(([name, value]) => ({ name, value })),
  };
};
exports.headers = async () => new Headers({ 'host': process.env.DEMO_ALLOWED_HOST, 'origin': process.env.APP_URL, 'user-agent': 'Synthetic functional QA', 'x-request-id': 'synthetic-qa' });
