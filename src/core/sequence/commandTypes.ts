import type {SequenceCommand} from './commands';

/**
 * SequenceCommand の判別子を実行時に列挙できる形で 1 箇所に持つ。
 *
 * transport 層（`src/server/sequence/api.ts`）が手書きの文字列配列で受理型を絞ると、
 * union に新コマンドを足したとき reducer のユニットテストは全緑のまま HTTP 経路だけが
 * 400 で死ぬ（T14 の `apply-text-style-all` / `set-text-style-hidden` が実際にそうなった）。
 * 受理集合はこの定数から導出し、ずれは下の型検査とテストで止める。
 */
export const SEQUENCE_COMMAND_TYPES = [
  'adopt-legacy-cut-history',
  'adopt-source-gap',
  'resize-cut-boundary',
  'fill-cut-captions',
  'split-caption',
  'merge-captions',
  'restore-cut',
  'rebase-native-insert-own-keyframe-clock',
  'register-native-insert-own-speed',
  'set-native-insert-own-speed',
  'rebase-native-insert-own-source',
  'upgrade-native-speed-operations',
  'set-native-global-speed',
  'set-native-main-speed',
  'reset-native-main-speed',
  'upgrade-native-speed',
  'register-native-speed',
  'set-scene-fades',
  'batch',
  'set-script',
  'set-ducking',
  'set-transcript',
  'ripple-delete',
  'reorder-ranges',
  'split',
  'delete',
  'move',
  'trim',
  'unlink',
  'add-track',
  'remove-track',
  'insert',
  'register-assets',
  'set-track-enabled',
  'move-track',
  'update-clip',
  'replace-audio-source',
  'replace-text-style-asset',
  'remove-asset',
  'set-transition',
  'apply-text-style-all',
  'set-text-style-hidden',
] as const;

export type SequenceCommandType = (typeof SEQUENCE_COMMAND_TYPES)[number];

/** `/command` 以外の専用ルートだけが発行する編集操作（transport の明示的な拒否リスト）。 */
export const SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP = [
  // 旧カットの引き継ぎ。/legacy-cuts/adopt が planId/planDigest の同一性を検証してから発行する。
  'adopt-legacy-cut-history',
  // 文字起こしの取り込み。/transcribe/apply が素材の指紋一致を検証してから発行する。
  'set-transcript',
  // 台本の構成変更。/script/edit-review の下見を通した結果からサーバーが組み立てる。
  'reorder-ranges',
] as const satisfies readonly SequenceCommandType[];

/**
 * 1 リクエストで実行できる編集操作（batch の葉）の上限。
 * transport（api.ts）が数え、UI（まとめドラッグ）も同じ値で先に断る。
 */
export const MAX_SEQUENCE_COMMAND_LEAVES = 50;

/** 履歴操作は SequenceCommand ではないが EditRequest の一部として /command が受ける。 */
export const SEQUENCE_HISTORY_COMMAND_TYPES = ['undo', 'redo'] as const;

type AssertNever<T extends never> = T;
/** 定数に union へ無い綴りが混ざったら tsc が落ちる。 */
export type NoExtraSequenceCommandType = AssertNever<Exclude<SequenceCommandType, SequenceCommand['type']>>;
/** union へメンバーを足して定数へ足し忘れたら tsc が落ちる。 */
export type NoMissingSequenceCommandType = AssertNever<Exclude<SequenceCommand['type'], SequenceCommandType>>;
