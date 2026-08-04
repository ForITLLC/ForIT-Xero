'use strict';

/**
 * Test harness for the Azure Functions handlers.
 *
 * The handlers register themselves with `app.http(...)` at module load and are
 * never exported, so the only way to drive the real handler is to load the
 * compiled module with a stub `@azure/functions` that captures registrations.
 *
 * Stubs are seeded straight into `require.cache` by resolved path — no mocking
 * dependency, which keeps `node --test` running with zero devDependencies.
 */

const Module = require('node:module');
const path = require('node:path');

const CONNECTOR_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(CONNECTOR_ROOT, 'dist', 'src');

function seedModule(absPath, exports) {
  const stub = new Module(absPath, null);
  stub.filename = absPath;
  stub.path = path.dirname(absPath);
  stub.loaded = true;
  stub.exports = exports;
  require.cache[absPath] = stub;
}

function resolveDep(request) {
  return require.resolve(request, { paths: [CONNECTOR_ROOT] });
}

const seededExternals = new Set();

function purge() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(DIST)) delete require.cache[key];
  }
  delete require.cache[resolveDep('@azure/functions')];
  for (const key of seededExternals) delete require.cache[key];
  seededExternals.clear();
}

/**
 * Load a compiled function module with stubbed dependencies and return the
 * handlers it registered, keyed by the registration name.
 *
 * @param {string} file      compiled module, relative to dist/src (e.g. 'functions/subscriptions.js')
 * @param {object} stubs     map of dist-relative module path -> exports (e.g. {'services/keyvault.js': {...}})
 * @returns {{handlers: Record<string, Function>, registrations: Array}}
 */
function loadFunctions(file, stubs = {}, externalStubs = {}) {
  purge();

  const registrations = [];
  const record = (kind) => (name, options) => registrations.push({ kind, name, options });
  seedModule(resolveDep('@azure/functions'), {
    app: {
      http: record('http'),
      timer: record('timer'),
      get: record('get'),
      post: record('post'),
    },
  });

  for (const [rel, exports] of Object.entries(stubs)) {
    seedModule(path.join(DIST, rel), exports);
  }

  // Third-party packages (mssql, stripe, the Azure SDKs) so no test can reach
  // the network or a real database.
  for (const [pkg, exports] of Object.entries(externalStubs)) {
    const resolved = resolveDep(pkg);
    seededExternals.add(resolved);
    seedModule(resolved, exports);
  }

  require(path.join(DIST, file));

  const handlers = {};
  for (const reg of registrations) {
    if (reg.options && typeof reg.options.handler === 'function') {
      handlers[reg.name] = reg.options.handler;
    }
  }
  return { handlers, registrations };
}

function makeRequest({ headers = {}, body = '', json, query = {}, url = 'https://xero.forit.io/api/test' } = {}) {
  const lowered = {};
  for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase()] = value;

  return {
    url,
    headers: { get: (key) => (key.toLowerCase() in lowered ? lowered[key.toLowerCase()] : null) },
    query: { get: (key) => (key in query ? query[key] : null) },
    text: async () => body,
    json: async () => (json !== undefined ? json : JSON.parse(body || '{}')),
  };
}

function makeContext() {
  const entries = [];
  const record = (level) => (...args) => entries.push({ level, args });
  return {
    entries,
    log: record('log'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    trace: record('trace'),
  };
}

/**
 * Everything the caller can actually see, flattened to one string: status,
 * headers (a redirect Location leaks just as effectively as a body) and body.
 */
function clientVisible(response) {
  return JSON.stringify({
    status: response?.status,
    headers: response?.headers ?? null,
    jsonBody: response?.jsonBody ?? null,
    body: response?.body ?? null,
  });
}

/** Everything that went to the logs, flattened to one string. */
function loggedText(context) {
  return context.entries
    .map((entry) => entry.args.map((arg) => {
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      if (typeof arg === 'string') return arg;
      try {
        return JSON.stringify(arg, (_key, value) => (value instanceof Error ? `${value.name}: ${value.message}` : value));
      } catch {
        return String(arg);
      }
    }).join(' '))
    .join('\n');
}

module.exports = {
  CONNECTOR_ROOT,
  DIST,
  loadFunctions,
  makeRequest,
  makeContext,
  clientVisible,
  loggedText,
};
