import { defineAsyncComponent } from 'vue'

const StubView = defineAsyncComponent(() => import('./views/StubView.vue'))

export const routes = {
  'dashboard': StubView,
  'run-detail': StubView,
  'workflow-history': StubView,
}
