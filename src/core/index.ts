// Harness Editor コアの公開 API。Plan 2（エディタアプリ）はここから import する。
export * from './types';
export { loadProject, serializeProject, type ProjectFiles } from './project';
export {
  normalizeCutRegions,
  applyCuts,
  cutRegionsFromCutData,
  playbackTotalFrames,
  originalToPlayback,
  playbackToOriginal,
  addCutRegion,
  removeCutRegion,
  monotoneToOrdered,
  orderedToMonotone,
} from './cutEngine';
export {
  cutOrderFromCutData,
  orderCutSegments,
  buildCutOrdering,
  cutOrderingOf,
  reorderStartEnd,
  unreorderStartEnd,
  reorderSe,
  unreorderSe,
} from './cutOrder';
export { anchorTelops, projectTelops, clampTelops, type ClampResult } from './telopEngine';
export { splitSegment, mergeSegments } from './segmentOps';
export { buildWordChips } from './wordChips';
export { validateProject } from './validation';
export { parseVideoConfig, parseVideoConfigStatic } from './videoConfig';
export { parseTranscript } from './transcript';
export { parseProjectConfig } from './projectConfig';
export { parseTelopData, serializeTelopData, formatTelopArray } from './telopData';
export { parseCutData, serializeCutData, formatCutArray } from './cutData';
export { parseSeData, serializeSeData, formatSeArray } from './seData';
export { anchorSe, projectSe, seInCutRegion } from './seAnchor';
export {
  parseInsertImageData,
  serializeInsertImageData,
  formatInsertImageArray,
} from './insertImageData';
export { anchorImages, projectImages, clampImages, imageInCutRegion } from './imageEngine';
export {
  parseInsertVideoData,
  serializeInsertVideoData,
  formatInsertVideoArray,
} from './insertVideoData';
export {
  anchorVideoInserts,
  projectVideoInserts,
  clampVideoInserts,
  videoInsertInCutRegion,
} from './videoInsertEngine';
export * from './bgmEngine';
export * from './bgmData';
export * from './bgmFade';
export { diffTelopData, type TelopDiffItem } from './telopLearning';
export { diffSeData, type SeDiffItem } from './seLearning';
