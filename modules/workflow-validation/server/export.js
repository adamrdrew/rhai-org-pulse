const RUNS_PREFIX = 'workflow-validation/runs';
const WORKFLOWS_PREFIX = 'workflow-validation/workflows';

module.exports = async function workflowValidationExport(addFile, storage) {
  const { readFromStorage, listStorageFiles } = storage;

  const runIndex = readFromStorage(RUNS_PREFIX + '/index.json');
  if (runIndex) {
    addFile(RUNS_PREFIX + '/index.json', runIndex);
  }

  let runFiles;
  try { runFiles = listStorageFiles(RUNS_PREFIX) || []; } catch { runFiles = []; }
  for (const fileName of runFiles) {
    if (fileName === 'index.json') continue;
    const run = readFromStorage(RUNS_PREFIX + '/' + fileName);
    if (!run) continue;
    addFile(RUNS_PREFIX + '/' + fileName, run);
  }

  const workflowIndex = readFromStorage(WORKFLOWS_PREFIX + '/index.json');
  if (workflowIndex) {
    addFile(WORKFLOWS_PREFIX + '/index.json', workflowIndex);
  }

  let workflowFiles;
  try { workflowFiles = listStorageFiles(WORKFLOWS_PREFIX) || []; } catch { workflowFiles = []; }
  for (const fileName of workflowFiles) {
    if (fileName === 'index.json') continue;
    const workflow = readFromStorage(WORKFLOWS_PREFIX + '/' + fileName);
    if (!workflow) continue;
    addFile(WORKFLOWS_PREFIX + '/' + fileName, workflow);
  }
};
