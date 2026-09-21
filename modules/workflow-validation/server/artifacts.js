const fs = require('fs');
const path = require('path');
const express = require('express');
const { SAFE_KEY_RE } = require('./validation');

const DEMO_MODE = process.env.DEMO_MODE === 'true';
const RUNS_PREFIX = 'workflow-validation/runs';
const REPORTS_DIR = 'workflow-validation/reports';
const VALID_TYPES = ['playwright', 'rca'];
const rawHtml = express.raw({ type: 'text/html', limit: '1mb' });

function resolveReportPath(dataDir, id, type) {
  const fileName = id + '-' + type + '.html';
  const filePath = path.resolve(dataDir, REPORTS_DIR, fileName);
  const resolvedDataDir = path.resolve(dataDir);
  if (!filePath.startsWith(resolvedDataDir + path.sep)) {
    return null;
  }
  return filePath;
}

/**
 * @param {import('express').Router} router
 * @param {object} context
 */
function registerArtifactRoutes(router, context) {
  const { storage, requireAdmin, requireScope } = context;
  const { readFromStorage } = storage;
  const dataDir = storage.DATA_DIR;

  /**
   * @openapi
   * /api/modules/workflow-validation/runs/{id}/artifacts:
   *   post:
   *     tags: [Workflow Validation]
   *     summary: Upload an HTML report artifact for a run
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: header
   *         name: X-Artifact-Type
   *         required: true
   *         schema: { type: string, enum: [playwright, rca] }
   *     requestBody:
   *       required: true
   *       content:
   *         text/html:
   *           schema: { type: string }
   *     responses:
   *       201:
   *         description: Artifact stored
   *       400:
   *         description: Invalid parameters
   *       404:
   *         description: Run not found
   */
  router.post('/runs/:id/artifacts', requireAdmin, requireScope('workflow-validation:write'), rawHtml, function(req, res) {
    if (DEMO_MODE) {
      return res.json({ status: 'skipped', message: 'Artifact upload disabled in demo mode' });
    }

    const id = req.params.id;
    if (!SAFE_KEY_RE.test(id)) {
      return res.status(400).json({ error: 'Invalid run ID' });
    }

    const type = req.headers['x-artifact-type'];
    if (!type || !VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'X-Artifact-Type header must be "playwright" or "rca"' });
    }

    const run = readFromStorage(RUNS_PREFIX + '/' + id + '.json');
    if (!run) {
      return res.status(404).json({ error: 'Run not found' });
    }

    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'Empty request body' });
    }

    const filePath = resolveReportPath(dataDir, id, type);
    if (!filePath) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpPath = filePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, req.body);
    fs.renameSync(tmpPath, filePath);

    res.status(201).json({ stored: id + '-' + type + '.html' });
  });

  /**
   * @openapi
   * /api/modules/workflow-validation/runs/{id}/report/{type}:
   *   get:
   *     tags: [Workflow Validation]
   *     summary: Serve a stored HTML report
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *       - in: path
   *         name: type
   *         required: true
   *         schema: { type: string, enum: [playwright, rca] }
   *     responses:
   *       200:
   *         description: HTML report content
   *         content:
   *           text/html:
   *             schema: { type: string }
   *       404:
   *         description: Report not found
   */
  router.get('/runs/:id/report/:type', requireScope('workflow-validation:read'), function(req, res) {
    const id = req.params.id;
    const type = req.params.type;

    if (!SAFE_KEY_RE.test(id)) {
      return res.status(400).json({ error: 'Invalid run ID' });
    }
    if (!VALID_TYPES.includes(type)) {
      return res.status(400).json({ error: 'Type must be "playwright" or "rca"' });
    }

    const filePath = resolveReportPath(dataDir, id, type);
    if (!filePath) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.setHeader('Content-Type', 'text/html');
    res.sendFile(filePath);
  });
}

module.exports = { registerArtifactRoutes };
