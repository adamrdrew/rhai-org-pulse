const { SAFE_KEY_RE } = require('./validation');

const RUNS_PREFIX = 'workflow-validation/runs';
const WORKFLOWS_PREFIX = 'workflow-validation/workflows';

function slugifyName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * @param {import('express').Router} router
 * @param {object} context
 */
function registerWorkflowRoutes(router, context) {
  const { storage, requireScope } = context;
  const { readFromStorage } = storage;

  /**
   * @openapi
   * /api/modules/workflow-validation/workflows:
   *   get:
   *     tags: [Workflow Validation]
   *     summary: List all workflows with latest status
   *     responses:
   *       200:
   *         description: Workflow summary list
   */
  router.get('/workflows', requireScope('workflow-validation:read'), function(req, res) {
    const index = readFromStorage(WORKFLOWS_PREFIX + '/index.json') || [];
    res.json(index);
  });

  /**
   * @openapi
   * /api/modules/workflow-validation/workflows/{name}:
   *   get:
   *     tags: [Workflow Validation]
   *     summary: Get per-workflow history, version-partitioned
   *     parameters:
   *       - in: path
   *         name: name
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Workflow history
   *       400:
   *         description: Invalid workflow name
   *       404:
   *         description: Workflow not found
   */
  router.get('/workflows/:name', requireScope('workflow-validation:read'), function(req, res) {
    const name = req.params.name;
    if (!SAFE_KEY_RE.test(name)) {
      return res.status(400).json({ error: 'Invalid workflow name' });
    }

    const workflow = readFromStorage(WORKFLOWS_PREFIX + '/' + name + '.json');
    if (!workflow) {
      return res.status(404).json({ error: 'Workflow not found' });
    }
    res.json(workflow);
  });
}

function rebuildWorkflowViews(storage) {
  const runFiles = storage.listStorageFiles(RUNS_PREFIX);
  const workflowMap = {};

  for (const file of runFiles) {
    if (file === 'index.json') continue;
    const run = storage.readFromStorage(RUNS_PREFIX + '/' + file);
    if (!run || !Array.isArray(run.workflows)) continue;

    for (const wf of run.workflows) {
      if (!wf.name) continue;

      const slug = slugifyName(wf.name);
      if (!workflowMap[slug]) {
        workflowMap[slug] = {
          name: wf.name,
          slug: slug,
          latestResult: null,
          latestTimestamp: null,
          passCount: 0,
          failCount: 0,
          totalRuns: 0,
          versions: {}
        };
      }

      const entry = workflowMap[slug];
      entry.totalRuns++;

      if (wf.result === 'PASS') entry.passCount++;
      if (wf.result === 'FAIL') entry.failCount++;

      if (!entry.latestTimestamp || run.timestamp > entry.latestTimestamp) {
        entry.latestTimestamp = run.timestamp;
        entry.latestResult = wf.result;
      }

      const trendKey = wf.trendKey || wf.name;
      if (!entry.versions[trendKey]) {
        entry.versions[trendKey] = [];
      }
      entry.versions[trendKey].push({
        runKey: run.key,
        timestamp: run.timestamp,
        result: wf.result,
        duration_s: wf.performer ? wf.performer.duration_s : null,
        costUsd: wf.performer ? wf.performer.costUsd : null
      });
    }
  }

  const indexEntries = [];

  for (const slug of Object.keys(workflowMap)) {
    const entry = workflowMap[slug];

    for (const trendKey of Object.keys(entry.versions)) {
      entry.versions[trendKey].sort(function(a, b) {
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });
    }

    storage.writeToStorageAtomic(WORKFLOWS_PREFIX + '/' + slug + '.json', {
      name: entry.name,
      slug: entry.slug,
      latestResult: entry.latestResult,
      latestTimestamp: entry.latestTimestamp,
      passRate: entry.totalRuns > 0 ? entry.passCount / entry.totalRuns : null,
      totalRuns: entry.totalRuns,
      versions: entry.versions
    });

    indexEntries.push({
      name: entry.name,
      slug: entry.slug,
      latestResult: entry.latestResult,
      latestTimestamp: entry.latestTimestamp,
      passRate: entry.totalRuns > 0 ? entry.passCount / entry.totalRuns : null,
      totalRuns: entry.totalRuns
    });
  }

  indexEntries.sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });

  storage.writeToStorageAtomic(WORKFLOWS_PREFIX + '/index.json', indexEntries);
}

module.exports = { registerWorkflowRoutes, rebuildWorkflowViews, slugifyName };
