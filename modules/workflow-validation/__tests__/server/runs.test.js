import { describe, it, expect, vi } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
  unlinkSync: vi.fn()
}));

import { registerRunRoutes, rebuildRunIndex, pruneOldRuns } from '../../server/runs.js';

function makeValidRun(key, timestamp) {
  return {
    schemaVersion: '1.0',
    key: key || 'run-001',
    timestamp: timestamp || '2026-06-01T12:00:00Z',
    cluster: { rhoaiVersion: '3.5.0', ocpVersion: '4.17.12' },
    summary: { totalWorkflows: 2, passed: 1, failed: 1, passRate: 0.5 },
    workflows: [
      { name: 'test-a', result: 'PASS' },
      { name: 'test-b', result: 'FAIL' }
    ]
  };
}

function makeContext(storageData = {}) {
  const store = { ...storageData };
  return {
    storage: {
      readFromStorage: vi.fn(function(key) { return store[key] || null; }),
      writeToStorage: vi.fn(function(key, data) { store[key] = data; }),
      writeToStorageAtomic: vi.fn(function(key, data) { store[key] = data; }),
      listStorageFiles: vi.fn(function() { return []; }),
      deleteFromStorage: vi.fn(function(key) { delete store[key]; }),
      DATA_DIR: '/tmp/test-data'
    },
    requireAdmin: (req, res, next) => next(),
    requireScope: () => (req, res, next) => next(),
    _store: store
  };
}

function createRouter() {
  const routes = {};
  const router = {
    get: vi.fn((path, ...handlers) => { routes['GET ' + path] = handlers; }),
    post: vi.fn((path, ...handlers) => { routes['POST ' + path] = handlers; })
  };
  return { router, routes };
}

function mockReqRes(body, params, query) {
  return {
    req: { body: body || {}, params: params || {}, query: query || {} },
    res: { json: vi.fn(), status: vi.fn().mockReturnThis() }
  };
}

async function callHandler(routes, method, path, body, params, query) {
  const key = method + ' ' + path;
  const handlers = routes[key];
  if (!handlers) throw new Error('No route for ' + key);
  const { req, res } = mockReqRes(body, params, query);
  const handler = handlers[handlers.length - 1];
  await handler(req, res);
  return { req, res };
}

describe('POST /runs/bulk', () => {
  it('rejects non-array body', async () => {
    const { router, routes } = createRouter();
    const context = makeContext();
    registerRunRoutes(router, context, {});

    const { res } = await callHandler(routes, 'POST', '/runs/bulk', { runs: 'nope' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'runs must be an array' });
  });

  it('rejects payload exceeding cap', async () => {
    const { router, routes } = createRouter();
    registerRunRoutes(router, makeContext(), {});

    const runs = Array.from({ length: 501 }, (_, i) => makeValidRun('run-' + i));
    const { res } = await callHandler(routes, 'POST', '/runs/bulk', { runs });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('500') }));
  });

  it('creates new records', async () => {
    const { router, routes } = createRouter();
    const context = makeContext();
    registerRunRoutes(router, context, {});

    const { res } = await callHandler(routes, 'POST', '/runs/bulk', {
      runs: [makeValidRun('run-001')]
    });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      created: 1, updated: 0, unchanged: 0
    }));
    expect(context.storage.writeToStorageAtomic).toHaveBeenCalledWith(
      'workflow-validation/runs/run-001.json',
      expect.objectContaining({ key: 'run-001' })
    );
  });

  it('detects unchanged records', async () => {
    const existing = makeValidRun('run-001', '2026-06-01T12:00:00Z');
    const { router, routes } = createRouter();
    const context = makeContext({ 'workflow-validation/runs/run-001.json': existing });
    registerRunRoutes(router, context, {});

    const { res } = await callHandler(routes, 'POST', '/runs/bulk', {
      runs: [makeValidRun('run-001', '2026-06-01T12:00:00Z')]
    });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      created: 0, updated: 0, unchanged: 1
    }));
  });

  it('detects updated records', async () => {
    const existing = makeValidRun('run-001', '2026-06-01T12:00:00Z');
    const { router, routes } = createRouter();
    const context = makeContext({ 'workflow-validation/runs/run-001.json': existing });
    registerRunRoutes(router, context, {});

    const { res } = await callHandler(routes, 'POST', '/runs/bulk', {
      runs: [makeValidRun('run-001', '2026-06-02T12:00:00Z')]
    });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      created: 0, updated: 1, unchanged: 0
    }));
  });

  it('reports validation errors', async () => {
    const { router, routes } = createRouter();
    registerRunRoutes(router, makeContext(), {});

    const { res } = await callHandler(routes, 'POST', '/runs/bulk', {
      runs: [{ key: '../bad' }]
    });

    const result = res.json.mock.calls[0][0];
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].key).toBe('../bad');
  });

  it('calls rebuildWorkflowViews after ingest', async () => {
    const rebuild = vi.fn();
    const { router, routes } = createRouter();
    registerRunRoutes(router, makeContext(), { rebuildWorkflowViews: rebuild });

    await callHandler(routes, 'POST', '/runs/bulk', { runs: [makeValidRun()] });
    expect(rebuild).toHaveBeenCalled();
  });
});

describe('GET /runs', () => {
  it('returns index data', async () => {
    const index = [
      { key: 'run-002', timestamp: '2026-06-02T00:00:00Z', cluster: { rhoaiVersion: '3.5.0' }, summary: { totalWorkflows: 2, passed: 2, failed: 0, skipped: 0 }, passRate: 1.0 },
      { key: 'run-001', timestamp: '2026-06-01T00:00:00Z', cluster: { rhoaiVersion: '3.4.0' }, summary: { totalWorkflows: 2, passed: 1, failed: 1, skipped: 0 }, passRate: 0.5 }
    ];
    const { router, routes } = createRouter();
    registerRunRoutes(router, makeContext({ 'workflow-validation/runs/index.json': index }), {});

    const { res } = await callHandler(routes, 'GET', '/runs', {}, {}, {});
    const result = res.json.mock.calls[0][0];
    expect(result.total).toBe(2);
    expect(result.runs).toHaveLength(2);
  });

  it('filters by version', async () => {
    const index = [
      { key: 'run-002', timestamp: '2026-06-02T00:00:00Z', cluster: { rhoaiVersion: '3.5.0' }, passRate: 1.0 },
      { key: 'run-001', timestamp: '2026-06-01T00:00:00Z', cluster: { rhoaiVersion: '3.4.0' }, passRate: 0.5 }
    ];
    const { router, routes } = createRouter();
    registerRunRoutes(router, makeContext({ 'workflow-validation/runs/index.json': index }), {});

    const { res } = await callHandler(routes, 'GET', '/runs', {}, {}, { version: '3.5' });
    const result = res.json.mock.calls[0][0];
    expect(result.total).toBe(1);
    expect(result.runs[0].key).toBe('run-002');
  });

  it('filters by date range', async () => {
    const index = [
      { key: 'run-002', timestamp: '2026-06-15T00:00:00Z', passRate: 1.0 },
      { key: 'run-001', timestamp: '2026-06-01T00:00:00Z', passRate: 0.5 }
    ];
    const { router, routes } = createRouter();
    registerRunRoutes(router, makeContext({ 'workflow-validation/runs/index.json': index }), {});

    const { res } = await callHandler(routes, 'GET', '/runs', {}, {}, { from: '2026-06-10' });
    const result = res.json.mock.calls[0][0];
    expect(result.total).toBe(1);
    expect(result.runs[0].key).toBe('run-002');
  });

  it('paginates results', async () => {
    const index = Array.from({ length: 5 }, (_, i) => ({
      key: 'run-' + i, timestamp: '2026-06-0' + (i + 1) + 'T00:00:00Z', passRate: 1.0
    }));
    const { router, routes } = createRouter();
    registerRunRoutes(router, makeContext({ 'workflow-validation/runs/index.json': index }), {});

    const { res } = await callHandler(routes, 'GET', '/runs', {}, {}, { limit: '2', offset: '1' });
    const result = res.json.mock.calls[0][0];
    expect(result.total).toBe(5);
    expect(result.runs).toHaveLength(2);
    expect(result.offset).toBe(1);
    expect(result.limit).toBe(2);
  });
});

describe('GET /runs/:id', () => {
  it('returns a run', async () => {
    const run = makeValidRun('run-001');
    const { router, routes } = createRouter();
    registerRunRoutes(router, makeContext({ 'workflow-validation/runs/run-001.json': run }), {});

    const { res } = await callHandler(routes, 'GET', '/runs/:id', {}, { id: 'run-001' });
    expect(res.json).toHaveBeenCalledWith(run);
  });

  it('returns 404 for missing run', async () => {
    const { router, routes } = createRouter();
    registerRunRoutes(router, makeContext(), {});

    const { res } = await callHandler(routes, 'GET', '/runs/:id', {}, { id: 'nope' });
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('rebuildRunIndex', () => {
  it('builds slim index from run files', () => {
    const run = makeValidRun('run-001');
    const storage = {
      listStorageFiles: vi.fn().mockReturnValue(['run-001.json']),
      readFromStorage: vi.fn().mockReturnValue(run),
      writeToStorageAtomic: vi.fn()
    };

    rebuildRunIndex(storage);

    expect(storage.writeToStorageAtomic).toHaveBeenCalledWith(
      'workflow-validation/runs/index.json',
      expect.arrayContaining([expect.objectContaining({ key: 'run-001' })])
    );
    const written = storage.writeToStorageAtomic.mock.calls[0][1];
    expect(written[0]).not.toHaveProperty('workflows');
    expect(written[0]).not.toHaveProperty('rootCauses');
  });

  it('skips index.json file', () => {
    const storage = {
      listStorageFiles: vi.fn().mockReturnValue(['index.json']),
      readFromStorage: vi.fn(),
      writeToStorageAtomic: vi.fn()
    };

    rebuildRunIndex(storage);
    expect(storage.readFromStorage).not.toHaveBeenCalled();
  });

  it('writes empty array when no files', () => {
    const storage = {
      listStorageFiles: vi.fn().mockReturnValue([]),
      writeToStorageAtomic: vi.fn()
    };

    rebuildRunIndex(storage);
    expect(storage.writeToStorageAtomic).toHaveBeenCalledWith(
      'workflow-validation/runs/index.json', []
    );
  });
});

describe('pruneOldRuns', () => {
  it('deletes runs older than 6 months and associated reports', () => {
    const oldDate = new Date();
    oldDate.setMonth(oldDate.getMonth() - 7);

    const storage = {
      listStorageFiles: vi.fn().mockReturnValue(['old-run.json']),
      readFromStorage: vi.fn().mockReturnValue({ timestamp: oldDate.toISOString() }),
      deleteFromStorage: vi.fn()
    };

    pruneOldRuns(storage);

    expect(storage.deleteFromStorage).toHaveBeenCalledWith('workflow-validation/runs/old-run.json');
    expect(storage.deleteFromStorage).toHaveBeenCalledWith('workflow-validation/reports/old-run-playwright.html');
    expect(storage.deleteFromStorage).toHaveBeenCalledWith('workflow-validation/reports/old-run-rca.html');
  });

  it('keeps recent runs', () => {
    const storage = {
      listStorageFiles: vi.fn().mockReturnValue(['new-run.json']),
      readFromStorage: vi.fn().mockReturnValue({ timestamp: new Date().toISOString() }),
      deleteFromStorage: vi.fn()
    };

    pruneOldRuns(storage);
    expect(storage.deleteFromStorage).not.toHaveBeenCalled();
  });
});
