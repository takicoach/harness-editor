import { normalizeCutRegions, originalToPlayback } from './cutEngine';
import type { BgmClip, CutRegion, DuckEnvelope, DuckingSettings, DuckingStrength, TranscriptWord } from './types';

/** 強さ→ダッキングゲイン（基準音量へ掛ける係数）。 */
export const DUCK_GAIN: Record<DuckingStrength, number> = { weak: 0.7, mid: 0.5, strong: 0.25 };

/** この無音（秒）以下なら喋り区間を結合する。 */
export const GAP_MERGE_SECONDS = 0.4;
/** 下げ始めのランプ（秒）。 */
export const ATTACK_SECONDS = 0.1;
/** 戻りのランプ（秒）。 */
export const RELEASE_SECONDS = 0.3;

export interface FrameRegion {
  start: number;
  end: number;
}

/**
 * 文字起こし単語（ms）を原本フレームの喋り区間へ。
 * 各単語を [round(start/1000*fps), round(end/1000*fps)) にし、長さ0は無視。
 * start 昇順にソートし、隣接ギャップが gapMergeFrames 以下なら結合する。
 */
export function buildSpeechRegions(
  words: TranscriptWord[],
  fps: number,
  gapMergeFrames: number,
): FrameRegion[] {
  const msToFrame = (ms: number): number => Math.round((ms / 1000) * fps);
  const raw: FrameRegion[] = [];
  for (const word of words) {
    const start = msToFrame(word.start);
    const end = msToFrame(word.end);
    if (end > start) raw.push({ start, end });
  }
  raw.sort((a, b) => a.start - b.start);
  const merged: FrameRegion[] = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end <= gapMergeFrames) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}

/**
 * 原本フレーム区間をカット適用後（再生）フレーム区間へ射影する。
 * clampBgm と同型: 端がカット区間内なら区間外へ寄せ、完全に飲まれた区間は捨てる。
 * その後 originalToPlayback で両端を射影する（端がカット境界の null は隣接フレームで補う）。
 * 区間内部のカットは originalToPlayback の累積削除で自動的に収縮する。
 */
export function speechRegionsToPlayback(original: FrameRegion[], regions: CutRegion[]): FrameRegion[] {
  const cuts = normalizeCutRegions(regions);
  const out: FrameRegion[] = [];
  for (const r of original) {
    let start = r.start;
    let end = r.end;
    for (const c of cuts) {
      if (start >= c.start && start < c.end) start = c.end;
      if (end > c.start && end <= c.end) end = c.start;
    }
    if (start >= end) continue; // カットに飲まれた
    const pStart = originalToPlayback(start, cuts) ?? (originalToPlayback(start - 1, cuts) ?? -1) + 1;
    const pEnd = originalToPlayback(end, cuts) ?? (originalToPlayback(end - 1, cuts) ?? -1) + 1;
    if (pEnd > pStart) out.push({ start: pStart, end: pEnd });
  }
  return out;
}

/**
 * 再生フレームの喋り区間を、クリップ [clipStartFrame, clipEndFrame) と交差させ
 * クリップ内相対フレームの DuckEnvelope を作る。交差が空なら undefined。
 */
export function bakeDuckEnvelope(
  clipStartFrame: number,
  clipEndFrame: number,
  playbackSpeech: FrameRegion[],
  gain: number,
  attackFrames: number,
  releaseFrames: number,
): DuckEnvelope | undefined {
  const regions: Array<{ start: number; end: number }> = [];
  for (const r of playbackSpeech) {
    const start = Math.max(r.start, clipStartFrame);
    const end = Math.min(r.end, clipEndFrame);
    if (end > start) regions.push({ start: start - clipStartFrame, end: end - clipStartFrame });
  }
  if (regions.length === 0) return undefined;
  return { regions, gain, attackFrames, releaseFrames };
}

/**
 * クリップ内フレームのダッキング係数（0..1）を返す。
 * 各 region [s,e) について: [s,e) 内=gain / [s-attack,s)=lerp(1→gain) /
 * [e,e+release)=lerp(gain→1) / それ以外=1。重なりは min（強い方）を採用。
 *
 * ★契約★ この式は固定旧原文 tests/fixtures/legacy-media-payloads/src/server/bgmPayload/BgmSequence.tsx.txt の duckFactor、および
 *   src/server/duckGainExpr.ts の regionExpr（ffmpeg volume 式への区分線形転写）と一致させる
 *   （bgmFadeVolume↔fadeVolume と同じ式の契約。旧配布runtimeは退役して原文を保全）。
 */
export function duckFactorAt(frameInClip: number, env: DuckEnvelope | undefined): number {
  if (!env || env.regions.length === 0) return 1;
  let factor = 1;
  for (const region of env.regions) {
    let local: number;
    if (frameInClip >= region.start && frameInClip < region.end) {
      local = env.gain;
    } else if (frameInClip < region.start && frameInClip >= region.start - env.attackFrames) {
      const t = (frameInClip - (region.start - env.attackFrames)) / env.attackFrames; // 0..1
      local = 1 + (env.gain - 1) * t;
    } else if (frameInClip >= region.end && frameInClip < region.end + env.releaseFrames) {
      const t = (frameInClip - region.end) / env.releaseFrames; // 0..1
      local = env.gain + (1 - env.gain) * t;
    } else {
      local = 1;
    }
    if (local < factor) factor = local;
  }
  return factor;
}

/**
 * 射影済み BgmClip[] へダッキングを焼き込む。設定 OFF / 未設定はそのまま返す。
 * 喋り区間（原本→再生）を一度だけ作り、各クリップへ bakeDuckEnvelope を適用する。
 * serializeProject（保存）と buildPlaybackModel（プレビュー）の両方から呼ぶ。
 */
export function applyDuckingToBgm(
  clips: BgmClip[],
  words: TranscriptWord[],
  cutRegions: CutRegion[],
  fps: number,
  settings: DuckingSettings | undefined,
): BgmClip[] {
  if (!settings || !settings.enabled) return clips;
  const gapMergeFrames = Math.round(GAP_MERGE_SECONDS * fps);
  const attackFrames = Math.max(1, Math.round(ATTACK_SECONDS * fps));
  const releaseFrames = Math.max(1, Math.round(RELEASE_SECONDS * fps));
  const gain = DUCK_GAIN[settings.strength];
  const speech = speechRegionsToPlayback(buildSpeechRegions(words, fps, gapMergeFrames), cutRegions);
  return clips.map((c) => {
    const env = bakeDuckEnvelope(c.startFrame, c.endFrame, speech, gain, attackFrames, releaseFrames);
    return env ? { ...c, ducking: env } : c;
  });
}
