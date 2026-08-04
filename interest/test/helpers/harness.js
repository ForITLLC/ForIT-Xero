'use strict';

/**
 * Same shape as the connector's harness: load a compiled function module with a
 * stubbed `@azure/functions` that captures registrations, so the REAL handler
 * can be driven without the Functions host and without any network or database.
 */

const Module = require('node:module');
const path = require('node:path');

const INTEREST_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(INTEREST_ROOT, 'dist', 'src');

const seededExternals = new Set();

function seedModule(absPath, exports) {
  const stub = new Module(absPath, null);
  stub.filename = absPath;
  stub.path = path.dirname(absPath);
  stub.loaded = true;
  stub.exports = exports;
  require.cache[absPath] = stub;
}

function resolveDep(request) {
  return require.resolve(request, { paths: [INTEREST_ROOT] });
}

function purge() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(DIST)) delete require.cache[key];
  }
  delete require.cache[resolveDep('@azure/functions')];
  for (const key of seededExternals) delete require.cache[key];
  seededExternals.clear();
}

function loadFunctions(file, stubs = {}, externalStubs = {}) {
  purge();

  const registrations = [];
  const record = (kind) => (name, options) => registrations.push({ kind, name, options });
  seedModule(resolveDep('@azure/functions'), {
    app: { http: record('http'), timer: record('timer') },
  });

  for (const [rel, exports] of Object.entries(stubs)) {
    seedModule(path.join(DIST, rel), exports);
  }
  for (const [pkg, exports] of Object.entries(externalStubs)) {
    const resolved = resolveDep(pkg);
    seededExternals.add(resolved);
    seedModule(resolved, exports);
  }

  require(path.join(DIST, file));

  const handlers = {};
  for (const reg of registrations) {
    if (reg.options && typeof reg.options.handler === 'function') handlers[reg.name] = reg.options.handler;
  }
  return { handlers, registrations };
}

function makeRequest({ headers = {}, json, query = {}, body = '' } = {}) {
  const lowered = {};
  for (const [key, value] of Object.entries(headers)) lowered[key.toLowerCase()] = value;
  return {
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

module.exports = { INTEREST_ROOT, DIST, loadFunctions, makeRequest, makeContext };
