/**
 * native 案件（`packId:'harness.builtin'` の凍結部品）へ新しい版を届ける 3 段導線。
 * `telopTemplateUpdate.ts` の 409（`reason:'telop-pack'`）は**外さない** — あれは案件の
 * `src/テロップテンプレート/` を実ファイルとしてパッチする仕組みで、native の凍結部品とは前提が違う。
 *
 * ①検知（この plan）②新資産生成（apply。旧資産は残す＝複数版共存）③参照切替（画面側が
 * `register-assets` → `replace-text-style-asset` を打つ）。**更新は明示ボタン経由のみ。**
 */
import type {SequenceAsset, SequenceDocument} from '../core/sequence/model';
import {currentBuiltinTextStyleAsset} from '../core/sequence/builtinTextStyleAsset';
import {activeTextAppearance, textComponentId, type TextContent} from '../core/sequence/textStyle';
import {telopClipsLosingAnimation} from '../core/sequence/telopAnimationSupport';
import {PACK_LEGACY_TELOP_ANIMATION_IDS} from '../core/telopLegacyAnimation';
import {BUILTIN_TELOP_PACK_ID, BUILTIN_TELOP_PACK_VERSION} from './telopPack/identity';
import {TELOP_PACK} from './telopPack/manifest';
import {prepareNativeTextStyles} from './sequence/textStyles';

export interface TelopPackUpdatePlan {
  /** 切替の起点になる資産。plan は起点があるときしか返さないので **null にならない**（レビュー I-1）。 */
  assetId: string;
  fromVersion: string;
  toVersion: string;
  /** その資産を参照している字幕クリップの数。 */
  captionCount: number;
  /** 更新すると**新しく動き始める**字幕の数（Codex P1-5。「失う 0 件」ではなく逆向きの数）。 */
  gainingCount: number;
  /** 更新すると選べなくなる動きを持つ字幕（スタイル単位の能力宣言で増減しうる）。 */
  losingClipIds: string[];
}

const APPLIED: ReadonlySet<string> = new Set<string>(PACK_LEGACY_TELOP_ANIMATION_IDS);

type Clip = SequenceDocument['clips'][number];

/** 現行 builtin 資産を**参照している**字幕。参照は `replace-text-style-asset` が切り替える単位そのもの
 *  （`commands.ts:675` は文書の全 telop から `fromAssetId` 参照を拾う）なので、自由書式も含む。
 *  案件テンプレート由来の字幕が混ざっていると、更新と無関係の件数が警告に出る（事前検査 B の F9-3）。
 *  `current` は**必須**（レビュー I-1。undefined を「全件」と読ませると、builtin 資産が 1 つも無い案件で
 *  絞り込みが全件通過に退化し、更新と無関係の字幕まで件数に乗る）。 */
function builtinReferences(document: SequenceDocument, current: SequenceAsset): Clip[] {
  return document.clips.filter(clip =>
    clip.content.kind === 'telop' && textComponentId(document, clip.content) === current.id);
}

/** 自由書式（`textMode:'free'`）の字幕は NativeText が描く。スタイル部品を差し替えても見た目は
 *  1 ピクセルも変わらないので、**件数の母集団に入れない**（最終レビュー N-1・Codex 2 巡目 #6。
 *  旧 builtin 資産＋`slideIn` の自由書式字幕が「動き始める」に数えられていた）。 */
const rendersWithComponent = (clip: Clip): boolean =>
  activeTextAppearance(clip.content as TextContent) === undefined;

/** 部品が実際に描いている字幕だけ＝`captionCount`・`gainingCount`・`losingClipIds` の母集団。 */
function builtinCaptions(document: SequenceDocument, current: SequenceAsset): Clip[] {
  return builtinReferences(document, current).filter(rendersWithComponent);
}

const gainsAnimation = (clip: Clip): boolean =>
  APPLIED.has(String((clip.content as {data: {animation?: unknown}}).data.animation ?? ''));

/**
 * 更新で**新しく動き始める**字幕の数。**母集団は呼び出し面ごとに違う**ので 2 本に分ける
 * （レビュー I-2。1 本に統合したとき、Remotion 一括更新の事前説明が native 側の字幕を数えていた）。
 * 共有するのは「動き始める」判定（`gainsAnimation`）だけ。
 *
 * こちらは native 3 段導線用＝**起点の builtin 凍結資産を参照している字幕**。
 */
export function countBuiltinTelopClipsGainingAnimation(
  document: SequenceDocument, current: SequenceAsset,
): number {
  return builtinCaptions(document, current).filter(gainsAnimation).length;
}

/**
 * Remotion 一括更新（`src/テロップテンプレート/` のファイルを差し替える導線）用＝
 * **案件フォルダの部品を参照している字幕**（builtin 以外）。そこで動きが付くのはこちらで、
 * builtin 資産を参照している字幕は一括更新では何も変わらない。
 */
export function countProjectTelopClipsGainingAnimation(document: SequenceDocument): number {
  const builtinIds = new Set(document.assets
    .filter(asset => asset.textStyleCatalog?.source === 'builtin').map(asset => asset.id));
  // 自由書式を外すのは native 側と同じ扱い（H-237/#238 の同型。Remotion 一括更新でも NativeText 描画は変わらない）。
  return document.clips.filter(clip => clip.content.kind === 'telop'
    && !builtinIds.has(textComponentId(document, clip.content) ?? ''))
    .filter(rendersWithComponent).filter(gainsAnimation).length;
}

/**
 * 更新後のカタログを**生成せずに**組み立てた見本。能力判定（`telopClipsLosingAnimation`）にしか使わない。
 * `prepareNativeTextStyles` を呼ぶと `storeSequenceComponent` が `.harness/components/<fingerprint>.mjs` を
 * 毎回書き、35 スタイルの esbuild が毎回走る — **読み取りのはずの操作でバイトが増える**（事前検査 B の F9-2）。
 * 生成は `applyTelopPackUpdate` だけが行う。
 */
export function nextBuiltinCatalogPreview(): SequenceAsset {
  return {
    id: '', kind: 'component', file: '', name: 'テロップスタイル', fingerprint: '', streams: [],
    textStyleCatalog: {source: 'builtin', packId: BUILTIN_TELOP_PACK_ID, version: BUILTIN_TELOP_PACK_VERSION,
      entries: TELOP_PACK.map(({id, name, animations}) => ({id, name, animations: [...animations]}))},
  } as unknown as SequenceAsset;
}

/** 計画が出せない理由。画面はこれで文言を選ぶ（`null` を一律「最新です」と読ませない。Codex 2 巡目 #4）。 */
export type TelopPackUpdateUnavailable =
  /** まだ同梱スタイルを使っていない案件（準備は別導線）。 */
  | 'not-adopted'
  /** 起点の資産はあるが版が現行と同じ。 */
  | 'up-to-date'
  /** 旧版の資産は残っているが、それを参照する字幕が 1 件も無い。 */
  | 'no-captions';

export type TelopPackUpdateOutcome =
  | {plan: TelopPackUpdatePlan; reason?: undefined}
  | {plan: null; reason: TelopPackUpdateUnavailable};

/** **同期**（compile も store もしない）。 */
export function planTelopPackUpdate(
  projectDirectory: string, document: SequenceDocument,
): TelopPackUpdateOutcome {
  void projectDirectory;   // 署名は 3 段導線の他 2 つと揃える（将来 marker を読む余地を残す）
  const current = currentBuiltinTextStyleAsset(document, BUILTIN_TELOP_PACK_VERSION);
  // 起点が無い＝この案件はまだ同梱スタイルを使っていない。更新の話ではないので候補にしない
  // （準備は `textStylePreparation('needs-builtin')` → `onPrepareTextStyles` の担当。レビュー I-1）。
  if (current === undefined) return {plan: null, reason: 'not-adopted'};
  const fromVersion = current.textStyleCatalog?.version;
  // 版が分からない（'unknown'・未設定）も更新候補。分からないものを「最新」とみなさない。
  if (fromVersion === BUILTIN_TELOP_PACK_VERSION) return {plan: null, reason: 'up-to-date'};
  // 全字幕が案件スタイルへ移ったあとに旧 builtin 資産だけ残ると、参照 0 件の計画が出て
  // apply が `replace-text-style-asset` の空集合拒否（`commands.ts:676`）で**必ず**落ちる。
  // 切り替える相手がいないのだから計画を返さない（Codex 2 巡目 #4）。
  const references = builtinReferences(document, current);
  if (references.length === 0) return {plan: null, reason: 'no-captions'};
  // 絞り込みも件数も `countBuiltinTelopClipsGainingAnimation` と同じ関数を通す（I2）。
  const captions = references.filter(rendersWithComponent);
  const gainingCount = captions.filter(gainsAnimation).length;
  // 数える対象もクリップ集合を絞った文書で見る（`telopClipsLosingAnimation` は文書内の全 telop を走る）。
  const scoped = {...document, clips: captions} as SequenceDocument;
  return {
    plan: {
      assetId: current.id,
      fromVersion: fromVersion ?? 'unknown',
      toVersion: BUILTIN_TELOP_PACK_VERSION,
      captionCount: captions.length,
      gainingCount,
      losingClipIds: telopClipsLosingAnimation(scoped, nextBuiltinCatalogPreview()),
    },
  };
}

/** 新しい資産を**凍結して返すだけ**。文書には触らない（登録と参照切替は画面側の 2 コマンド）。 */
export async function applyTelopPackUpdate(projectDirectory: string): Promise<SequenceAsset> {
  return prepareNativeTextStyles(projectDirectory);
}
