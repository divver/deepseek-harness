/**
 * Cross-session master/worker plan cooperation over a workspace-shared file
 * store. Default export is the plugin (the `CoopService` class); the Loader
 * instantiates it with the validated {@link Config}.
 * @module @deepseek-ai/dsh-coop
 */

import { CoopService, Config } from './service.ts'

export default CoopService
export { CoopService, Config }
export { CoopError, PlanId, canCommunicate, coopRoot, normalizeCwd, resolveCoopConfig } from './runtime.ts'
export type { ResolvedCoopConfig } from './runtime.ts'
export {
  COOP_POLICY_ORDER,
  COOP_POLICY_SECTION_NAME,
  COOP_POLICY_TEXT,
} from './policy.ts'
export * from './store.ts'
export type * from './types.ts'
