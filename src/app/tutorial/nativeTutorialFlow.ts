/**
 * 新画面チュートリアルの進行の純関数（DOM / React に触れない）。
 * 「対象外（この画面では出せない）」と「準備待ち（出せるが文書がまだ）」を分ける:
 *   - 対象外は nextNativeIndex で飛ばす（ホームで編集の手順、編集でホームの手順、条件を満たさない手順）。
 *   - 準備待ちは飛ばさず nativeTutorialView が waiting を返す。
 */
import type { SequenceCommand } from '../../core/sequence/commands';
import type { SequenceDocument } from '../../core/sequence/model';
import { NATIVE_CREATE_BAND_TEXT, NATIVE_WAITING_TEXT, type NativeTutorialStep } from './nativeTutorialSteps';

export type NativeScene = 'home' | 'edit';

export interface NativeFlowFacts {
  hasProjects: boolean;
  /** 体験で本人が追加したテロップの記録があるか。 */
  hasRecord: boolean;
}

/** from 以降で、この画面で出せる最初の手順の添字。無ければ steps.length。 */
export function nextNativeIndex(steps: readonly NativeTutorialStep[], from: number, scene: NativeScene, facts: NativeFlowFacts): number {
  for (let i = Math.max(0, from); i < steps.length; i++) {
    const step = steps[i];
    if (step === undefined) continue;
    if (step.scene !== 'any' && step.scene !== scene) continue;
    if (step.requiresProjects && !facts.hasProjects) continue;
    if (step.requiresRecord && !facts.hasRecord) continue;
    return i;
  }
  return steps.length;
}

/** index より後で最初に来る編集画面の手順（作成成功時の再開先）。 */
export function firstEditStepAfter(steps: readonly NativeTutorialStep[], index: number): string | null {
  return steps.slice(index + 1).find((step) => step.scene === 'edit')?.id ?? null;
}

/** ページをまたいで再開してよい手順（編集画面の手順で、記録が要らないもの）。 */
export function resumableStepIds(steps: readonly NativeTutorialStep[]): string[] {
  return steps.filter((step) => step.scene === 'edit' && !step.requiresRecord).map((step) => step.id);
}

export type NativeTutorialView =
  | { kind: 'off' }
  | { kind: 'hidden' }
  | { kind: 'band'; text: string }
  | { kind: 'waiting'; text: string }
  | { kind: 'step' };

export interface NativeViewFacts {
  active: boolean;
  step: NativeTutorialStep | null;
  scene: NativeScene;
  /** ホーム: 一覧の取得済み。編集: 文書が操作可能。 */
  ready: boolean;
  loadFailed: boolean;
  dialogOpen: boolean;
  createDialogOpen: boolean;
  /** 手順の前提状態を整えている最中。 */
  preparing: boolean;
}

/** いまの見せ方。優先順: 作成ダイアログの案内帯 → ダイアログで隠す → 読み込み失敗（編集画面・全手順） → 準備待ち → 整え中 → 通常。 */
export function nativeTutorialView(f: NativeViewFacts): NativeTutorialView {
  if (!f.active || f.step === null) return { kind: 'off' };
  if (f.step.id === 'create' && f.createDialogOpen) return { kind: 'band', text: NATIVE_CREATE_BAND_TEXT };
  if (f.dialogOpen) return { kind: 'hidden' };
  if (f.scene === 'edit' && f.loadFailed) return { kind: 'hidden' }; // 場面 any（welcome/finish）もエラー表示の上には出さない
  if (f.step.scene === f.scene && !f.ready) return { kind: 'waiting', text: NATIVE_WAITING_TEXT };
  if (f.preparing) return { kind: 'hidden' };
  return { kind: 'step' };
}

/** 体験で本人が追加したテロップの記録（addText / addElement('title') の成功時に作る）。 */
export interface NativeTelopRecord {
  documentId: string;
  clipId: string;
  trackId: string;
}

/**
 * 「取り除く」のコマンド。記録した 1 件と、それで空になるトラックだけを消す。
 * 後続の本人・AI の編集は巻き戻さない（Undo は使わない）。消すものが無ければ null。
 */
export function telopRemovalCommand(document: SequenceDocument, record: NativeTelopRecord): SequenceCommand | null {
  if (document.id !== record.documentId) return null;
  const commands: SequenceCommand[] = [];
  if (document.clips.some((clip) => clip.id === record.clipId)) commands.push({ type: 'delete', clipIds: [record.clipId] });
  const trackExists = document.tracks.some((track) => track.id === record.trackId);
  const othersOnTrack = document.clips.some((clip) => clip.trackId === record.trackId && clip.id !== record.clipId);
  if (trackExists && !othersOnTrack) commands.push({ type: 'remove-track', trackId: record.trackId });
  if (commands.length === 0) return null;
  return commands.length === 1 ? commands[0]! : { type: 'batch', commands };
}
