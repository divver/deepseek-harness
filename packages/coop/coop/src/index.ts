/**
 * Cross-session master/worker plan cooperation over a workspace-shared file
 * store. Default export is the plugin (the `CoopService` class); the Loader
 * instantiates it with the validated {@link Config}.
 * @module @deepseek-ai/dsh-coop
 */

import { CoopService, Config } from './service.ts'

export default CoopService
export { CoopService, Config }
export { CoopError, MasterId, PlanId, canCommunicate, coopRoot, mintMasterId, normalizeCwd, resolveCoopConfig, v2Root } from './runtime.ts'
export type { QualityGateConfig, QualityGateSettings, ResolvedCoopConfig, ResolvedQualityGate } from './runtime.ts'
export { registerCoopBundledSkills } from './bundled-skills.ts'
export { default as bundledSkillsPlugin } from './bundled-skills.ts'
export {
  COOP_POLICY_ORDER,
  COOP_POLICY_SECTION_NAME,
  COOP_POLICY_TEXT,
  COOP_V2_POLICY_TEXT,
} from './policy.ts'
export * from './store.ts'
export type * from './types.ts'
