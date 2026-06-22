const { registerRunRoutes } = require('./runs');
const { registerWorkflowRoutes, rebuildWorkflowViews } = require('./workflows');
const { registerArtifactRoutes } = require('./artifacts');

/**
 * @param {import('express').Router} router
 * @param {import('@shared/server/module-context').ModuleContext} context
 */
module.exports = function registerRoutes(router, context) {
  context.registerScopes([
    { key: 'workflow-validation:read', label: 'Workflow Validation (Read)', description: 'Read workflow validation data', category: 'Workflow Validation' },
    { key: 'workflow-validation:write', label: 'Workflow Validation (Write)', description: 'Write workflow validation data', category: 'Workflow Validation' }
  ]);

  registerRunRoutes(router, context, { rebuildWorkflowViews });
  registerWorkflowRoutes(router, context);
  registerArtifactRoutes(router, context);

  if (context.registerDiagnostics) {
    context.registerDiagnostics(async function() {
      const { readFromStorage } = context.storage;
      const runIndex = readFromStorage('workflow-validation/runs/index.json');
      const workflowIndex = readFromStorage('workflow-validation/workflows/index.json');
      return {
        status: 'ok',
        totalRuns: Array.isArray(runIndex) ? runIndex.length : 0,
        totalWorkflows: Array.isArray(workflowIndex) ? workflowIndex.length : 0
      };
    });
  }

  if (context.registerExport) {
    context.registerExport(require('./export'));
  }
};
