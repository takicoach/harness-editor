import type { SequenceClip, SequenceTrack } from '../../core/sequence/model';

export type TrackAccent = '--track-video' | '--track-jimaku' | '--track-title' | '--track-telop' | '--track-image' | '--track-vi' | '--track-bgm' | '--track-se' | '--track-shape';

/** 色点メニューに出す 9 色（styles.css の --track-* トークン名と表示名）。 */
export const TRACK_ACCENTS: ReadonlyArray<{ token: TrackAccent; label: string }> = [
  { token: '--track-jimaku', label: '青（字幕）' }, { token: '--track-title', label: '紫（章・タイトル）' }, { token: '--track-telop', label: 'ローズ（注釈）' },
  { token: '--track-image', label: '橙（画像・背景）' }, { token: '--track-shape', label: '赤紫（図形）' }, { token: '--track-vi', label: '青緑' },
  { token: '--track-video', label: '灰（映像）' }, { token: '--track-bgm', label: '緑（原音・BGM）' }, { token: '--track-se', label: '黄（効果音）' },
];

/** 1 段目: 役割の既定色。トラック自体は visual / audio の 2 種しか無いので、映像トラックは載っているクリップの種類で決める。
 *  タイトルだけ→紫、図形だけ→赤紫、テロップ（字幕・注釈は種類では区別できない）→ローズ、画像→橙。 */
export function trackKindAccent(track: SequenceTrack, clips: readonly SequenceClip[]): TrackAccent {
  if (track.kind === 'audio') return /効果音|SE/i.test(track.name) ? '--track-se' : '--track-bgm';
  const kinds = clips.filter(c => c.trackId === track.id).map(c => c.content.kind);
  if (kinds.length > 0 && kinds.every(k => k === 'title')) return '--track-title';
  if (kinds.length > 0 && kinds.every(k => k === 'telop' || k === 'title')) return '--track-telop';
  if (kinds.length > 0 && kinds.every(k => k === 'shape')) return '--track-shape';
  if (kinds.length > 0 && kinds.every(k => k === 'image' || k === 'shape')) return '--track-image';
  return '--track-video';
}

/** 2 段目: 同じ既定色のトラックが 2 本以上並ぶとき、同種の n 本目を 3 色で巡回させる（F7）。 */
const CYCLES: Partial<Record<TrackAccent, TrackAccent[]>> = {
  '--track-telop': ['--track-telop', '--track-jimaku', '--track-title'],
  '--track-image': ['--track-image', '--track-vi', '--track-shape'],
};

/**
 * トラックヘッダーとクリップを染める種別色。3 段: 上書き（色点メニュー・ローカル保存）→ 同種の巡回 → 種類の既定色。
 * `tracks` を省くと巡回しない（第 1 期までの呼び出しと同じ結果）。
 * 巡回順は同種トラックの並び順（siblings）であり、全トラック中の絶対位置ではない。
 *
 * I-6: `kinds` は `trackKindAccent` の事前計算（トラック id → 既定色）。省略すると毎回
 * 全クリップを走査するため、再生中の毎フレーム描画では呼び手が useMemo した map を渡す。
 * 渡しても結果は変わらない（同じ値を引くだけ）。
 */
export function trackAccent(track: SequenceTrack, clips: readonly SequenceClip[], tracks: readonly SequenceTrack[] = [track], overrides: Readonly<Record<string, TrackAccent>> = {}, kinds?: ReadonlyMap<string, TrackAccent>): TrackAccent {
  const override = overrides[track.id];
  if (override) return override;
  const kindOf = (t: SequenceTrack) => kinds?.get(t.id) ?? trackKindAccent(t, clips);
  const base = kindOf(track);
  const cycle = CYCLES[base];
  if (!cycle) return base;
  const siblings = tracks.filter(t => kindOf(t) === base);
  if (siblings.length < 2) return base;
  return cycle[Math.max(0, siblings.findIndex(t => t.id === track.id)) % cycle.length]!;
}
