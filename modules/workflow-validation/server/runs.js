const express = require('express');
const { validateRunRecord } = require('./validation');

const DEMO_MODE = process.env.DEMO_MODE === 'true';
const BULK_CAP = 500;
const RETENTION_MONTHS = 6;
const RUNS_PREFIX = 'workflow-validation/runs';
const jsonLimit = express.json({ limit: '30mb' });

let storeWriteInProgress = false;

/**
 * @param {import('express').Router} router
 * @param {object} context
 * @param {object} deps - { rebuildWorkflowViews }
 */
function registerRunRoutes(router, context, deps) {
  const { storage, requireAdmin, requireScope } = context;
  const { readFromStorage, writeToStorageAtomic } = storage;

  /**
   * @openapi
   * /api/modules/workflow-validation/runs/bulk:
   *   post:
   *     tags: [Workflow Validation]
   *     summary: Bulk ingest workflow validation run records
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               runs:
   *                 type: array
   *                 items:
   *                   type: object
   *     responses:
   *       200:
   *         description: Upsert results with created/updated/unchanged counts
   *       400:
   *         description: Invalid request body
   */
  router.post('/runs/bulk', requireAdmin, requireScope('workflow-validation:write'), jsonLimit, async function(req, res) {
    if (DEMO_MODE) {
      return res.json({ status: 'skipped', message: 'Run ingest disabled in demo mode' });
    }

    const { runs } = req.body;
    if (!Array.isArray(runs)) {
      return res.status(400).json({ error: 'runs must be an array' });
    }
    if (runs.length > BULK_CAP) {
      return res.status(400).json({ error: `Bulk payload exceeds maximum of ${BULK_CAP} entries` });
    }

    try {
      const counts = { created: 0, updated: 0, unchanged: 0 };
      const errors = [];

      while (storeWriteInProgress) {
        await new Promise(function(resolve) { setTimeout(resolve, 100); });
      }
      storeWriteInProgress = true;

      try {
        for (const entry of runs) {
          const result = validateRunRecord(entry);
          if (!result.valid) {
            errors.push({ key: entry?.key || 'unknown', errors: result.errors });
            continue;
          }

          const storageKey = RUNS_PREFIX + '/' + entry.key + '.json';
          const existing = readFromStorage(storageKey);

          if (existing) {
            if (existing.timestamp === entry.timestamp) {
              counts.unchanged++;
              continue;
            }
            counts.updated++;
          } else {
            counts.created++;
          }

          writeToStorageAtomic(storageKey, entry);
        }

        pruneOldRuns(storage);
        rebuildRunIndex(storage);
        if (deps.rebuildWorkflowViews) {
          deps.rebuildWorkflowViews(storage);
        }
      } finally {
        storeWriteInProgress = false;
      }

      res.json({
        created: counts.created,
        updated: counts.updated,
        unchanged: counts.unchanged,
        errors
      });
    } catch (err) {
      console.error('[workflow-validation] Bulk ingest error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * @openapi
   * /api/modules/workflow-validation/runs:
   *   get:
   *     tags: [Workflow Validation]
   *     summary: List workflow validation runs
   *     parameters:
   *       - in: query
   *         name: version
   *         schema: { type: string }
   *         description: Filter by RHOAI version
   *       - in: query
   *         name: from
   *         schema: { type: string }
   *         description: Start date (ISO 8601)
   *       - in: query
   *         name: to
   *         schema: { type: string }
   *         description: End date (ISO 8601)
   *       - in: query
   *         name: limit
   *         schema: { type: integer, default: 50 }
   *       - in: query
   *         name: offset
   *         schema: { type: integer, default: 0 }
   *     responses:
   *       200:
   *         description: Paginated list of runs
   */
  router.get('/runs', requireScope('workflow-validation:read'), function(req, res) {
    const index = readFromStorage(RUNS_PREFIX + '/index.json') || [];

    let filtered = index;

    if (req.query.version) {
      filtered = filtered.filter(function(r) {
        return r.cluster && r.cluster.rhoaiVersion && r.cluster.rhoaiVersion.includes(req.query.version);
      });
    }

    if (req.query.from) {
      const from = new Date(req.query.from).getTime();
      if (!isNaN(from)) {
        filtered = filtered.filter(function(r) { return new Date(r.timestamp).getTime() >= from; });
      }
    }
    if (req.query.to) {
      const to = new Date(req.query.to).getTime();
      if (!isNaN(to)) {
        filtered = filtered.filter(function(r) { return new Date(r.timestamp).getTime() <= to; });
      }
    }

    const total = filtered.length;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const page = filtered.slice(offset, offset + limit);

    res.json({ total, limit, offset, runs: page });
  });

  /**
   * @openapi
   * /api/modules/workflow-validation/runs/{id}:
   *   get:
   *     tags: [Workflow Validation]
   *     summary: Get a single workflow validation run
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Run record
   *       404:
   *         description: Run not found
   */
  router.get('/runs/:id', requireScope('workflow-validation:read'), function(req, res) {
    const run = readFromStorage(RUNS_PREFIX + '/' + req.params.id + '.json');
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json(run);
  });
}

function rebuildRunIndex(storage) {
  const files = storage.listStorageFiles(RUNS_PREFIX);
  if (!files.length) {
    storage.writeToStorageAtomic(RUNS_PREFIX + '/index.json', []);
    return;
  }

  const entries = [];
  for (const file of files) {
    if (file === 'index.json') continue;
    const run = storage.readFromStorage(RUNS_PREFIX + '/' + file);
    if (!run) continue;

    entries.push({
      key: run.key,
      timestamp: run.timestamp,
      cluster: run.cluster || null,
      summary: run.summary ? {
        totalWorkflows: run.summary.totalWorkflows,
        passed: run.summary.passed,
        failed: run.summary.failed,
        skipped: run.summary.skipped || 0
      } : null,
      passRate: run.summary ? run.summary.passRate : null
    });
  }

  entries.sort(function(a, b) {
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  storage.writeToStorageAtomic(RUNS_PREFIX + '/index.json', entries);
}

function pruneOldRuns(storage) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - RETENTION_MONTHS);
  const cutoffMs = cutoff.getTime();

  const files = storage.listStorageFiles(RUNS_PREFIX);
  for (const file of files) {
    if (file === 'index.json') continue;
    const run = storage.readFromStorage(RUNS_PREFIX + '/' + file);
    if (!run || !run.timestamp) continue;

    if (new Date(run.timestamp).getTime() < cutoffMs) {
      const key = file.replace('.json', '');
      storage.deleteFromStorage(RUNS_PREFIX + '/' + file);
      storage.deleteFromStorage('workflow-validation/reports/' + key + '-playwright.html');
      storage.deleteFromStorage('workflow-validation/reports/' + key + '-rca.html');
    }
  }
}

module.exports = { registerRunRoutes, rebuildRunIndex, pruneOldRuns };
