import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import WorkflowsView from '../../client/views/WorkflowsView.vue'

const { getFilters, getTestSuites } = vi.hoisted(() => ({
  getFilters: vi.fn(),
  getTestSuites: vi.fn(),
}))

vi.mock('../../client/composables/useWorkflowValidation', async (importOriginal) => ({
  ...await importOriginal(),
  useWorkflowValidation: () => ({ getFilters, getTestSuites }),
}))

describe('Workflow Validation Trends suite selection', () => {
  let wrapper
  let runs

  beforeEach(() => {
    vi.clearAllMocks()
    window.history.replaceState({}, '', '#/workflow-validation/workflows?datePreset=all')
    runs = [
      { suite: 'ad-hoc', invocationId: 'ad-hoc-latest', timestamp: '2026-10-02T10:00:00Z', rhoaiVersion: '3.6', tests: 1, passed: 1, failed: 0, errors: 0, passRate: 1, productBugs: [] },
      { suite: 'release-gate', invocationId: 'release-gate-older', timestamp: '2026-10-01T10:00:00Z', rhoaiVersion: '3.6', tests: 1, passed: 1, failed: 0, errors: 0, passRate: 1, productBugs: [] },
    ]
    getFilters.mockResolvedValue({ versions: [], testSuites: [{ value: 'ad-hoc' }, { value: 'release-gate' }] })
    getTestSuites.mockImplementation(async ({ suite } = {}) => ({
      rows: suite ? runs.filter((run) => run.suite === suite) : runs,
    }))
  })

  afterEach(() => wrapper?.unmount())

  async function openTrends() {
    wrapper = mount(WorkflowsView, {
      global: {
        provide: { moduleNav: { navigateTo: vi.fn(), updateParams: vi.fn() } },
        stubs: { TestRunOutcomeChart: true, TestRunBugChart: true, TestRunBugVersionChart: true },
      },
    })
    await flushPromises()
    return wrapper.get('select[aria-label="Test Suite"]')
  }

  it.each(['release-gate', 'release_gate'])('defaults to %s even when Ad Hoc has the latest run', async (suite) => {
    getFilters.mockResolvedValue({ versions: [], testSuites: [{ value: 'ad-hoc' }, { value: suite }] })
    runs[1].suite = suite

    const select = await openTrends()

    expect(select.element.value).toBe(suite)
    expect(getTestSuites).toHaveBeenLastCalledWith(expect.objectContaining({ suite }))
  })

  it.each(['testRun', 'suite'])('preserves an explicit Ad Hoc selection in the %s URL parameter', async (parameter) => {
    window.history.replaceState({}, '', `#/workflow-validation/workflows?datePreset=all&${parameter}=ad-hoc`)

    const select = await openTrends()

    expect(select.element.value).toBe('ad-hoc')
    expect(getTestSuites).toHaveBeenLastCalledWith(expect.objectContaining({ suite: 'ad-hoc' }))
  })

  it('allows the user to switch from the default to Ad Hoc', async () => {
    const select = await openTrends()
    expect(select.element.value).toBe('release-gate')

    await select.setValue('ad-hoc')
    await flushPromises()

    expect(select.element.value).toBe('ad-hoc')
    expect(getTestSuites).toHaveBeenLastCalledWith(expect.objectContaining({ suite: 'ad-hoc' }))
  })

  it('keeps the latest-run fallback when Release Gate is unavailable', async () => {
    getFilters.mockResolvedValue({ versions: [], testSuites: [{ value: 'legacy-validation' }, { value: 'ad-hoc' }] })
    runs = runs.filter((run) => run.suite === 'ad-hoc')

    const select = await openTrends()

    expect(select.element.value).toBe('ad-hoc')
    expect(getTestSuites).toHaveBeenLastCalledWith(expect.objectContaining({ suite: 'ad-hoc' }))
  })
})
