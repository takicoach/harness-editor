// ハーネス形式学習ループ（LL Phase A）の公開 API。
export * from './types';
export { learnStart, learnFinish, TRACKED_FILES } from './learn';
export { runCli, type CliResult } from './cli';
export { loadStore, saveStore, appendHistory } from './store';
export { promoteWordRules, unlearnWord, partitionByConflict } from './promote';
export { snapshotBaseline, type SnapshotResult } from './baseline';
export { diffSegmentText, diffTranscriptFixed } from './segmentDiff';
export { distillWordRules } from './distill';
export { parseTranscriptFixed } from './transcriptFixed';
export { emptyTypoDict, parseTypoDict, serializeTypoDict } from './typoDict';
export {
  applyCutFeedback,
  emptyCutRules,
  CUT_RULE_PROMOTION_THRESHOLD,
  type CutFeedbackEntry,
  type CutRule,
  type CutRulesFile,
} from './cutRules';
export {
  appendCutFeedback,
  loadCutRules,
  saveCutRules,
  recordApprovedCutFeedback,
  countUndistilledFeedback,
  countJsonlLines,
} from './cutStore';
export {
  applyTelopFeedback,
  emptyTelopRules,
  TELOP_RULE_PROMOTION_THRESHOLD,
  type TelopFeedbackEntry,
  type TelopRule,
  type TelopRulesFile,
} from './telopRules';
export {
  appendTelopFeedback,
  loadTelopRules,
  saveTelopRules,
  recordApprovedTelopFeedback,
} from './telopStore';
export {
  applySeFeedback,
  emptySeRules,
  SE_RULE_PROMOTION_THRESHOLD,
  type SeFeedbackEntry,
  type SeRule,
  type SeRulesFile,
} from './seRules';
export {
  appendSeFeedback,
  loadSeRules,
  saveSeRules,
  recordApprovedSeFeedback,
} from './seStore';
