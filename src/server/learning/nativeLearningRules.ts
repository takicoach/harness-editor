/**
 * 新形式（取り込み案件）の学習差分の規則。純関数だけを置く（ファイルは読まない）。
 *
 * 比較元 = 新エディターへ取り込んだ時点の旧形式ファイル（`src/core/project.ts` の loadProject の解釈）。
 * 仕上げ = 完了した書き出しジョブの文書（.harness/exports/<jobId>/input.json）。
 * harvest_v2（learn スキル）の規則を土台に、設計書 D5 の3点（空の cutData・cutArchive 内のテロップ・
 * 分かれたテロップの修正）を意図的に直している。
 *
 * 空の cutData（cutData.ts 不在）を「全カット」（cutRegions = [[0, durationFrames]] 相当）に
 * 変換するのは loadProject 側の責務であり、このファイルの関数は変換済みの `legacyCutRegions` を
 * 受け取る前提で組む（本ファイル自身は空配列を「未カット」として扱う）。
 */
import type { CutRegion, EditorSe, EditorTelop, TranscriptWord } from '../../core/types';
import type { SequenceAsset, SequenceClip } from '../../core/sequence/model';
import { timeNumber } from '../../core/sequence/time';
import type { LearningCutDiffItem, LearningSeDiffItem, LearningTelopDiffItem } from '../../shared/types';

/** 有理数を整数フレームへ丸めた誤差を差分として拾わない（harvest_v2 の MIN_CUT_FRAMES と同じ）。 */
export const MIN_CUT_FRAMES = 3;

/**
 * 発話が無いカット区間の表示用プレースホルダ。
 * 学習キーとしては意味を持たない（全ての無音区間が同じ文字列に潰れる）ため、承認時の記録からは除外する。
 */
export const SILENT_CUT_TEXT = '(無音)';

/**
 * 承認項目の照合キー（候補との照合・同じ要求の中の重複の除去に使う）。記録に効く値だけで作る
 * （カットは種類・区間・語、テロップは種類・前後の本文、SE は種類・ファイル・文脈の字幕）。
 */
export const cutCandidateKey = (c: LearningCutDiffItem) => JSON.stringify([c.kind, c.startFrame, c.endFrame, c.text]);
export const telopCandidateKey = (t: LearningTelopDiffItem) => JSON.stringify([t.kind, t.before, t.after]);
export const seCandidateKey = (s: LearningSeDiffItem) => JSON.stringify([s.kind, s.file, s.nearbyText]);

export type FrameSpan = [number, number];
export interface TextSpan { startFrame: number; endFrame: number; text: string }

/** 区間を開始順に並べ、重なり・接触を併合する（長さ0以下は捨てる）。 */
export function mergeSpans(list: FrameSpan[]): FrameSpan[] {
  const sorted = list.filter(([a, b]) => b > a).map(([a, b]): FrameSpan => [a, b]).sort((x, y) => x[0] - y[0]);
  const out: FrameSpan[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** a から b を引いた残り（どちらも併合済みの区間列）。 */
export function subtractSpans(a: FrameSpan[], b: FrameSpan[]): FrameSpan[] {
  const out: FrameSpan[] = [];
  for (const [s, e] of a) {
    let cur = s;
    for (const [bs, be] of b) {
      if (be <= cur || bs >= e) continue;
      if (bs > cur) out.push([cur, bs]);
      cur = Math.max(cur, be);
      if (cur >= e) break;
    }
    if (cur < e) out.push([cur, e]);
  }
  return out;
}

/** 比較元の残す範囲 = [0, durationFrames] から cutRegions を引いた残り（空の cutData は loadProject が全カットにする）。 */
export function keptSpansFromCutRegions(cutRegions: CutRegion[], durationFrames: number): FrameSpan[] {
  return subtractSpans([[0, durationFrames]], mergeSpans(cutRegions.map((r): FrameSpan => [r.start, r.end])));
}

/**
 * 仕上げの残す範囲。主映像（primaryAssetId）の video クリップごとに
 * [round(sourceIn×fps), round(開始 + durationFrames×rate)] を作って併合する。開始を先に丸める（harvest_v2 と同じ）。
 */
export function finishKeptSpans(clips: SequenceClip[], primaryAssetId: string, fps: number): FrameSpan[] {
  return mergeSpans(clips.flatMap((clip): FrameSpan[] => {
    if (clip.content.kind !== 'video' || clip.content.assetId !== primaryAssetId) return [];
    const start = Math.round(timeNumber(clip.content.sourceIn) * fps);
    return [[start, Math.round(start + clip.durationFrames * timeNumber(clip.content.rate))]];
  }));
}

/** 区間に完全に含まれる語をつなげる（ミリ秒で比べる。harvest_v2・旧 learningApi と同じ）。 */
export function wordsInSpan(words: TranscriptWord[], startFrame: number, endFrame: number, fps: number): string {
  const s = (startFrame / fps) * 1000, e = (endFrame / fps) * 1000;
  return words.filter((w) => w.start >= s && w.end <= e).map((w) => w.text).join('');
}

export interface NativeCutDiffInput {
  legacyCutRegions: CutRegion[];
  durationFrames: number;
  fps: number;
  clips: SequenceClip[];
  primaryAssetId: string;
  words: TranscriptWord[];
}

/** カット差分: 比較元で残し仕上げで消えた範囲 = added-cut、その逆 = restored-cut。3 フレーム未満は捨てる。 */
export function diffNativeCuts(input: NativeCutDiffInput): LearningCutDiffItem[] {
  const legacyKeep = keptSpansFromCutRegions(input.legacyCutRegions, input.durationFrames);
  const finishKeep = finishKeptSpans(input.clips, input.primaryAssetId, input.fps);
  const long = ([a, b]: FrameSpan) => b - a >= MIN_CUT_FRAMES;
  const item = (kind: LearningCutDiffItem['kind']) => ([startFrame, endFrame]: FrameSpan): LearningCutDiffItem => {
    const text = wordsInSpan(input.words, startFrame, endFrame, input.fps);
    return { kind, startFrame, endFrame, startSec: startFrame / input.fps, endSec: endFrame / input.fps, text: text === '' ? SILENT_CUT_TEXT : text };
  };
  return [
    ...subtractSpans(legacyKeep, finishKeep).filter(long).map(item('added-cut')),
    ...subtractSpans(finishKeep, legacyKeep).filter(long).map(item('restored-cut')),
  ];
}

const telopText = (clip: SequenceClip): string => (clip.content.kind === 'telop' ? String(clip.content.data.text ?? '') : '');
const telopLegacyId = (clip: SequenceClip): number | undefined =>
  clip.content.kind === 'telop' && typeof clip.content.legacyId === 'number' ? clip.content.legacyId : undefined;
const uniqueInOrder = (texts: string[]): string[] => [...new Set(texts)];
function group<K>(map: Map<K, SequenceClip[]>, key: K, clip: SequenceClip): void {
  const list = map.get(key);
  if (list) list.push(clip);
  else map.set(key, [clip]);
}

export interface NativeTelopDiffInput {
  /** 比較元のテロップ（loadProject の project.telops。時刻は原本フレーム）。 */
  legacyTelops: EditorTelop[];
  /** 仕上げの本編クリップ（document.clips）。 */
  clips: SequenceClip[];
  /** 仕上げの cutArchive に移ったクリップ（全 entry の clips を平らにしたもの）。 */
  archivedClips: SequenceClip[];
  legacyFps: number;
  finishFps: number;
}

/**
 * テロップ差分（kind:'telop' のみ。title は対象外）。
 * - legacyId で比較元と対応づける。比較元と違う本文がちょうど1種類ならそれを仕上げとする（changed）。
 *   2種類以上に分かれていればあいまいなので候補にしない。
 * - 対応する断片が本編にも cutArchive にも無い場合だけ removed。
 * - legacyId の無いクリップは continuationGroupId||id ごとに added（本文は重複なく時刻順につなぐ）。
 */
export function diffNativeTelops(input: NativeTelopDiffInput): LearningTelopDiffItem[] {
  const telops = input.clips.filter((c) => c.content.kind === 'telop').sort((a, b) => a.startFrame - b.startFrame);
  const byLegacy = new Map<number, SequenceClip[]>();
  const added = new Map<string, SequenceClip[]>();
  for (const clip of telops) {
    const legacyId = telopLegacyId(clip);
    if (legacyId !== undefined) group(byLegacy, legacyId, clip);
    else group(added, clip.continuationGroupId || clip.id, clip);
  }
  const archived = new Set(input.archivedClips.flatMap((c) => {
    const legacyId = telopLegacyId(c);
    return legacyId === undefined ? [] : [legacyId];
  }));
  const finishSpan = (clips: SequenceClip[]) => {
    const startFrame = Math.min(...clips.map((c) => c.startFrame));
    const endFrame = Math.max(...clips.map((c) => c.startFrame + c.durationFrames));
    return { startFrame, endFrame, startSec: startFrame / input.finishFps, endSec: endFrame / input.finishFps };
  };
  const out: LearningTelopDiffItem[] = [];
  for (const legacy of input.legacyTelops) {
    const fragments = byLegacy.get(legacy.id);
    if (!fragments) {
      if (archived.has(legacy.id)) continue;
      out.push({ kind: 'removed', before: legacy.text, after: '', startFrame: legacy.originalStart, endFrame: legacy.originalEnd,
        startSec: legacy.originalStart / input.legacyFps, endSec: legacy.originalEnd / input.legacyFps });
      continue;
    }
    const changed = uniqueInOrder(fragments.map(telopText)).filter((text) => text !== legacy.text);
    if (changed.length === 1) out.push({ kind: 'changed', before: legacy.text, after: changed[0]!, ...finishSpan(fragments) });
  }
  for (const fragments of added.values()) {
    out.push({ kind: 'added', before: '', after: uniqueInOrder(fragments.map(telopText)).join(''), ...finishSpan(fragments) });
  }
  return out;
}

/** frame を含む字幕、無ければ最も近い字幕（同じ距離なら時刻が前の字幕）の本文。 */
export function nearestText(items: TextSpan[], frame: number): string {
  const sorted = [...items].sort((a, b) => a.startFrame - b.startFrame);
  const hit = sorted.find((t) => t.startFrame <= frame && frame < t.endFrame);
  if (hit) return hit.text;
  let best: TextSpan | undefined;
  let bestDistance = Infinity;
  for (const t of sorted) {
    const distance = Math.min(Math.abs(t.startFrame - frame), Math.abs(t.endFrame - frame));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = t;
    }
  }
  return best?.text ?? '';
}

export interface NativeSeDiffInput {
  /** 比較元の効果音（loadProject の project.se。時刻は原本フレーム）。 */
  legacySe: EditorSe[];
  legacyTelops: EditorTelop[];
  clips: SequenceClip[];
  archivedClips: SequenceClip[];
  assets: SequenceAsset[];
  legacyFps: number;
  finishFps: number;
}

const isEffect = (clip: SequenceClip): boolean => clip.content.kind === 'audio' && clip.content.role === 'effect';
const effectOwner = (clip: SequenceClip): string => clip.legacyAudioContinuity?.ownerClipId || clip.continuationGroupId || clip.id;
const legacyEffectId = (owner: string): number | null => {
  const match = /^legacy-effect-(\d+)$/.exec(owner);
  return match ? Number(match[1]) : null;
};

/**
 * SE 差分（kind:'audio' && role:'effect' のみ。BGM は含めない）。
 * 持ち主が legacy-effect-N で本編か cutArchive に残るものは存続。それ以外の持ち主は1回ずつ added、
 * 存続しなかった比較元の SE は removed。文脈の字幕は added＝仕上げ側、removed＝比較元から取る。
 */
export function diffNativeSes(input: NativeSeDiffInput): LearningSeDiffItem[] {
  const surviving = new Set<number>();
  for (const clip of [...input.clips, ...input.archivedClips]) {
    if (!isEffect(clip)) continue;
    const legacyId = legacyEffectId(effectOwner(clip));
    if (legacyId !== null) surviving.add(legacyId);
  }
  const finishTelops: TextSpan[] = input.clips.filter((c) => c.content.kind === 'telop')
    .map((c) => ({ startFrame: c.startFrame, endFrame: c.startFrame + c.durationFrames, text: telopText(c) }));
  const legacyTelops: TextSpan[] = input.legacyTelops.map((t) => ({ startFrame: t.originalStart, endFrame: t.originalEnd, text: t.text }));
  const out: LearningSeDiffItem[] = [];
  const addedOwners = new Set<string>();
  for (const clip of input.clips.filter(isEffect).sort((a, b) => a.startFrame - b.startFrame)) {
    const owner = effectOwner(clip);
    if (legacyEffectId(owner) !== null || addedOwners.has(owner)) continue;
    addedOwners.add(owner);
    const assetId = clip.content.kind === 'audio' ? clip.content.assetId : '';
    const file = input.assets.find((asset) => asset.id === assetId)?.name ?? clip.name;
    out.push({ kind: 'added', startFrame: clip.startFrame, startSec: clip.startFrame / input.finishFps, file,
      nearbyText: nearestText(finishTelops, clip.startFrame) });
  }
  for (const se of input.legacySe) {
    if (surviving.has(se.id)) continue;
    out.push({ kind: 'removed', startFrame: se.originalStart, startSec: se.originalStart / input.legacyFps, file: se.file,
      nearbyText: nearestText(legacyTelops, se.originalStart) });
  }
  return out;
}
