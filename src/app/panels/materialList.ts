/** 素材ライブラリで扱う4種別。 */
export type MaterialKind = 'se' | 'image' | 'bgm' | 'video';

export interface MaterialKindMeta {
  kind: MaterialKind;
  /** セグメント切替の表示名。 */
  label: string;
  /** /api/asset の path prefix。video は '' (ファイル名そのまま)。 */
  assetDir: string;
  /** 素材が無いときの見出し（「〜がまだありません」）。 */
  emptyTitle: string;
  /** 素材が無いときの次の一手の案内（ドロップ対象のファイル種別）。 */
  emptyHint: string;
  /** SE/BGM は試聴可。 */
  isAudio: boolean;
  /** 画像/サブ動画はサムネ表示。 */
  isThumb: boolean;
}

export const MATERIAL_KINDS: MaterialKindMeta[] = [
  { kind: 'se', label: '効果音', assetDir: 'se', emptyTitle: '効果音がまだありません', emptyHint: '音声ファイル（mp3 / wav）をここにドロップすると使えます', isAudio: true, isThumb: false },
  { kind: 'image', label: '画像', assetDir: 'images', emptyTitle: '画像がまだありません', emptyHint: '画像ファイル（png / jpg）をここにドロップすると使えます', isAudio: false, isThumb: true },
  { kind: 'bgm', label: 'BGM', assetDir: 'BGM', emptyTitle: 'BGM がまだありません', emptyHint: '曲ファイル（mp3 / wav）をここにドロップすると使えます', isAudio: true, isThumb: false },
  { kind: 'video', label: 'サブ動画', assetDir: '', emptyTitle: 'サブ動画がまだありません', emptyHint: '動画ファイル（mp4 / mov）をここにドロップすると使えます', isAudio: false, isThumb: true },
];

/** 種別＋ファイル名から /api/asset の path を作る。 */
export function assetPathFor(kind: MaterialKind, file: string): string {
  const meta = MATERIAL_KINDS.find((m) => m.kind === kind);
  const dir = meta ? meta.assetDir : '';
  return dir === '' ? file : `${dir}/${file}`;
}

/**
 * projectId と assetPath から /api/asset URL を作る。
 * versions（assetPath → size-mtime トークン）にエントリがあれば &v= を付け、
 * 同名差し替え時に波形デコードキャッシュ（URL キー）とメディア要素を自然に無効化する。
 */
export function assetUrl(
  projectId: string,
  assetPath: string,
  versions?: Record<string, string>,
): string {
  const base = `/api/asset?id=${encodeURIComponent(projectId)}&path=${encodeURIComponent(assetPath)}`;
  const v = versions?.[assetPath];
  return v === undefined ? base : `${base}&v=${encodeURIComponent(v)}`;
}

export interface MaterialRow {
  file: string;
  assetPath: string;
}

/** ライブラリ（ファイル名配列）を表示用の行データへ変換する。 */
export function buildMaterialRows(kind: MaterialKind, library: string[]): MaterialRow[] {
  return library.map((file) => ({ file, assetPath: assetPathFor(kind, file) }));
}

/** サムネ表示用のシーク秒。短尺は中央、長尺は 0.5 秒で代表フレームを選ぶ。 */
export function thumbSeekTime(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.min(0.5, durationSec / 2);
}
