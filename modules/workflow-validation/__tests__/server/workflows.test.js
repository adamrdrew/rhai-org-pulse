import { describe, it, expect, vi } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([])
}));

import { registerWorkflowRoutes, rebuildWorkflowViews, slugifyName } from '../../server/workflows.js';

function makeRun(key, timestamp, workflows) {
  return {
    key,
    timestamp,
    workflows: workflows.map(function(w) {
      return { name: w.name, trendKey: w.trendKey || w.name, result: w.result, performer: w.performer || null };
    })
  };
}

function makeContext(storageData = {}) {
  const store = { ...storageData };
  return {
    storage: {
      readFromStorage: vi.fn(function(key) { return store[key] || null; }),
      writeToStorageAtomic: vi.fn(function(key, data) { store[key] = data; }),
      listStorageFiles: vi.fn(function() { return []; }),
      DATA_DIR: '/tmp/test-data'
    },
    requireScope: () => (req, res, next) => next(),
    _store: store
  };
}

function createRouter() {
  const routes = {};
  return {
    router: {
      get: vi.fn((path, ...handlers) => { routes['GET ' + path] = handlers; }),
      post: vi.fn((path, ...handlers) => { routes['POST ' + path] = handlers; })
    },
    routes
  };
}

async function callHandler(routes, method, path, params) {
  const key = method + ' ' + path;
  const handlers = routes[key];
  if (!handlers) throw new Error('No route for ' + key);
  const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };
  const req = { params: params || {}, query: {} };
  await handlers[handlers.length - 1](req, res);
  return { req, res };
}

describe('slugifyName', () => {
  it('passes through safe names', () => {
    expect(slugifyName('llm-serving-basic')).toBe('llm-serving-basic');
  });

  it('replaces unsafe characters', () => {
    expect(slugifyName('test with spaces')).toBe('test-with-spaces');
  });

  it('collapses repeated hyphens', () => {
    expect(slugifyName('test--name')).toBe('test-name');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugifyName('-test-')).toBe('test');
  });
});

describe('rebuildWorkflowViews', () => {
  it('builds per-workflow files and index', () => {
    const storage = {
      listStorageFiles: vi.fn().mockReturnValue(['run-001.json', 'run-002.json']),
      readFromStorage: vi.fn(function(key) {
        if (key.endsWith('run-001.json')) {
          return makeRun('run-001', '2026-06-01T00:00:00Z', [
            { name: 'test-a', result: 'PASS' },
            { name: 'test-b', result: 'FAIL' }
          ]);
        }
        if (key.endsWith('run-002.json')) {
          return makeRun('run-002', '2026-06-02T00:00:00Z', [
            { name: 'test-a', result: 'PASS' },
            { name: 'test-b', result: 'PASS' }
          ]);
        }
        return null;
      }),
      writeToStorageAtomic: vi.fn()
    };

    rebuildWorkflowViews(storage);

    const writeCalls = storage.writeToStorageAtomic.mock.calls;
    const indexCall = writeCalls.find(function(c) { return c[0] === 'workflow-validation/workflows/index.json'; });
    expect(indexCall).toBeTruthy();

    const index = indexCall[1];
    expect(index).toHaveLength(2);

    const testA = index.find(function(w) { return w.name === 'test-a'; });
    expect(testA.passRate).toBe(1.0);
    expect(testA.totalRuns).toBe(2);

    const testB = index.find(function(w) { return w.name === 'test-b'; });
    expect(testB.passRate).toBe(0.5);
    expect(testB.latestResult).toBe('PASS');
  });

  it('groups by trendKey for version-partitioned history', () => {
    const storage = {
      listStorageFiles: vi.fn().mockReturnValue(['run-001.json']),
      readFromStorage: vi.fn().mockReturnValue(
        makeRun('run-001', '2026-06-01T00:00:00Z', [
          { name: 'test-a', trendKey: 'test-a@3.5', result: 'PASS' }
        ])
      ),
      writeToStorageAtomic: vi.fn()
    };

    rebuildWorkflowViews(storage);

    const wfCall = storage.writeToStorageAtomic.mock.calls.find(function(c) {
      return c[0] === 'workflow-validation/workflows/test-a.json';
    });
    expect(wfCall).toBeTruthy();

    const wf = wfCall[1];
    expect(wf.versions['test-a@3.5']).toHaveLength(1);
    expect(wf.versions['test-a@3.5'][0].result).toBe('PASS');
  });

  it('writes empty index when no runs exist', () => {
    const storage = {
      listStorageFiles: vi.fn().mockReturnValue([]),
      readFromStorage: vi.fn(),
      writeToStorageAtomic: vi.fn()
    };

    rebuildWorkflowViews(storage);
    expect(storage.writeToStorageAtomic).toHaveBeenCalledWith(
      'workflow-validation/workflows/index.json', []
    );
  });
});

describe('GET /workflows', () => {
  it('returns workflow index', async () => {
    const index = [{ name: 'test-a', slug: 'test-a', passRate: 1.0, totalRuns: 5 }];
    const { router, routes } = createRouter();
    registerWorkflowRoutes(router, makeContext({ 'workflow-validation/workflows/index.json': index }));

    const { res } = await callHandler(routes, 'GET', '/workflows');
    expect(res.json).toHaveBeenCalledWith(index);
  });

  it('returns empty array when no data', async () => {
    const { router, routes } = createRouter();
    registerWorkflowRoutes(router, makeContext());

    const { res } = await callHandler(routes, 'GET', '/workflows');
    expect(res.json).toHaveBeenCalledWith([]);
  });
});

describe('GET /workflows/:name', () => {
  it('returns workflow detail', async () => {
    const detail = { name: 'test-a', versions: { 'test-a@3.5': [] } };
    const { router, routes } = createRouter();
    registerWorkflowRoutes(router, makeContext({ 'workflow-validation/workflows/test-a.json': detail }));

    const { res } = await callHandler(routes, 'GET', '/workflows/:name', { name: 'test-a' });
    expect(res.json).toHaveBeenCalledWith(detail);
  });

  it('returns 404 for missing workflow', async () => {
    const { router, routes } = createRouter();
    registerWorkflowRoutes(router, makeContext());

    const { res } = await callHandler(routes, 'GET', '/workflows/:name', { name: 'nope' });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('rejects unsafe names', async () => {
    const { router, routes } = createRouter();
    registerWorkflowRoutes(router, makeContext());

    const { res } = await callHandler(routes, 'GET', '/workflows/:name', { name: '../escape' });
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
