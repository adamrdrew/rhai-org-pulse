import { describe, it, expect } from 'vitest';
import { validateRunRecord } from '../../server/validation.js';

function makeValidRecord() {
  return {
    schemaVersion: '1.0',
    key: 'run-12345',
    timestamp: '2026-06-01T12:00:00Z',
    summary: { totalWorkflows: 2, passed: 1, failed: 1 },
    workflows: [
      { name: 'test-a', result: 'PASS' },
      { name: 'test-b', result: 'FAIL' }
    ]
  };
}

describe('validateRunRecord', () => {
  it('accepts a valid record', () => {
    const result = validateRunRecord(makeValidRecord());
    expect(result.valid).toBe(true);
    expect(result.data).toEqual(makeValidRecord());
  });

  it('rejects null', () => {
    const result = validateRunRecord(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Entry must be a non-null object');
  });

  it('rejects missing key', () => {
    const record = makeValidRecord();
    delete record.key;
    const result = validateRunRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('key')]));
  });

  it('rejects unsafe key characters', () => {
    const record = makeValidRecord();
    record.key = '../escape/attempt';
    const result = validateRunRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('unsafe')]));
  });

  it('rejects missing timestamp', () => {
    const record = makeValidRecord();
    delete record.timestamp;
    const result = validateRunRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('timestamp')]));
  });

  it('rejects invalid timestamp', () => {
    const record = makeValidRecord();
    record.timestamp = 'not-a-date';
    const result = validateRunRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('ISO 8601')]));
  });

  it('rejects missing schemaVersion', () => {
    const record = makeValidRecord();
    delete record.schemaVersion;
    const result = validateRunRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('schemaVersion')]));
  });

  it('rejects missing summary', () => {
    const record = makeValidRecord();
    delete record.summary;
    const result = validateRunRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('summary')]));
  });

  it('rejects summary with wrong types', () => {
    const record = makeValidRecord();
    record.summary = { totalWorkflows: 'two', passed: 1, failed: 1 };
    const result = validateRunRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('totalWorkflows')]));
  });

  it('rejects missing workflows', () => {
    const record = makeValidRecord();
    delete record.workflows;
    const result = validateRunRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('workflows')]));
  });

  it('rejects workflow with missing name', () => {
    const record = makeValidRecord();
    record.workflows = [{ result: 'PASS' }];
    const result = validateRunRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('workflows[0].name')]));
  });

  it('rejects workflow with invalid result', () => {
    const record = makeValidRecord();
    record.workflows = [{ name: 'test', result: 'MAYBE' }];
    const result = validateRunRecord(record);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('PASS, FAIL')]));
  });

  it('collects multiple errors', () => {
    const result = validateRunRecord({ key: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});
