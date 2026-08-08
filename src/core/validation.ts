import { playbackTotalFrames } from './cutEngine';
import { clampTelops } from './telopEngine';
import type { CutRegion, EditorTelop, ValidationResult } from './types';

interface ValidateInput {
  originalTotalFrames: number;
  cutRegions: CutRegion[];
  telops: EditorTelop[];
}

/** プロジェクトの状態を検証し、警告・エラーを返す（spec 12 章）。 */
export function validateProject(input: ValidateInput): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const playback = playbackTotalFrames(input.originalTotalFrames, input.cutRegions);
  if (input.originalTotalFrames > 0 && playback < input.originalTotalFrames * 0.5) {
    warnings.push(
      `カットしすぎの可能性: 残り尺が元の ${Math.round(
        (playback / input.originalTotalFrames) * 100,
      )}% です`,
    );
  }

  const { flaggedIds } = clampTelops(input.telops, input.cutRegions);
  for (const id of flaggedIds) {
    warnings.push(`テロップ #${id} がカット区間内に入り表示されません`);
  }

  return { errors, warnings };
}
