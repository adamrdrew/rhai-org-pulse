const SAFE_KEY_RE = /^[a-zA-Z0-9._-]+$/;

const VALID_RESULTS = ['PASS', 'FAIL', 'SKIP', 'ERROR'];

function validateRunRecord(entry) {
  const errors = [];

  if (!entry || typeof entry !== 'object') {
    return { valid: false, errors: ['Entry must be a non-null object'] };
  }

  if (!entry.key || typeof entry.key !== 'string') {
    errors.push('Missing or invalid "key" field');
  } else if (!SAFE_KEY_RE.test(entry.key)) {
    errors.push('Key contains unsafe characters (allowed: alphanumeric, dots, hyphens, underscores)');
  }

  if (!entry.timestamp || typeof entry.timestamp !== 'string') {
    errors.push('Missing or invalid "timestamp" field');
  } else {
    const parsed = Date.parse(entry.timestamp);
    if (isNaN(parsed)) {
      errors.push('Timestamp is not a valid ISO 8601 date');
    }
  }

  if (!entry.schemaVersion || typeof entry.schemaVersion !== 'string') {
    errors.push('Missing or invalid "schemaVersion" field');
  }

  if (!entry.summary || typeof entry.summary !== 'object') {
    errors.push('Missing or invalid "summary" object');
  } else {
    if (typeof entry.summary.totalWorkflows !== 'number') {
      errors.push('summary.totalWorkflows must be a number');
    }
    if (typeof entry.summary.passed !== 'number') {
      errors.push('summary.passed must be a number');
    }
    if (typeof entry.summary.failed !== 'number') {
      errors.push('summary.failed must be a number');
    }
  }

  if (!Array.isArray(entry.workflows)) {
    errors.push('Missing or invalid "workflows" array');
  } else {
    for (let i = 0; i < entry.workflows.length; i++) {
      const wf = entry.workflows[i];
      if (!wf || typeof wf !== 'object') {
        errors.push(`workflows[${i}] must be an object`);
        continue;
      }
      if (!wf.name || typeof wf.name !== 'string') {
        errors.push(`workflows[${i}].name must be a non-empty string`);
      }
      if (!wf.result || typeof wf.result !== 'string') {
        errors.push(`workflows[${i}].result must be a non-empty string`);
      } else if (!VALID_RESULTS.includes(wf.result)) {
        errors.push(`workflows[${i}].result must be one of: ${VALID_RESULTS.join(', ')}`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: entry };
}

module.exports = { validateRunRecord, SAFE_KEY_RE };
