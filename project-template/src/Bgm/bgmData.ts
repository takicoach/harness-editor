import type { BgmClip } from './types';

// BGM クリップ（エディタの BGM トラックで表示・編集される正本）。
// file は public/BGM/ 内のファイル名のみ（パス・拡張子込みの例: 'Groove Machine.mp3'）。
// ショート標準: volume 0.08・全尺1クリップ・fadeOutFrames 45（harness-edit の Init が設定する）。
export const bgmData: BgmClip[] = [];
