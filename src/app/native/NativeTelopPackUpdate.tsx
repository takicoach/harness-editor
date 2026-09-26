import {useMemo, useRef, useState} from 'react';
import {extractErrorMessage} from '../fetchJson';
import {textComponentId} from '../../core/sequence/textStyle';
import type {SequenceAsset, SequenceDocument} from '../../core/sequence/model';

/** HTTP 越しに来る値なので、サーバ側の型（`assetId: string`）より緩く受けて画面側で弾く。 */
interface PackPlanView {
  assetId: string | null; fromVersion: string; toVersion: string;
  captionCount: number; gainingCount: number; losingClipIds: string[];
}

/** 計画が出せない理由ごとの文言。`plan:null` を一律「最新です」と言わない（Codex 2 巡目 #4）。
 *  reason が無い応答（旧い経路）は従来どおり「最新です」に落とす。 */
const UNAVAILABLE_NOTICE: Record<string, string> = {
  'not-adopted': 'この案件はまだ同梱テロップスタイルを使っていないので、更新するものがありません。',
  'up-to-date': 'このテロップスタイルは最新です。',
  'no-captions': 'このテロップスタイルを使っている字幕が無いので、更新する対象がありません。',
};

export interface TelopPackUpdateProps {
  projectId: string;
  document: SequenceDocument;
  disabled: boolean;
  onRegisterAsset(asset: SequenceAsset): Promise<boolean>;
  onReplaceAsset(fromAssetId: string, toAssetId: string): Promise<boolean>;
}

/**
 * 同梱テロップスタイルの版を上げる導線（設計 §6.4）。**押すまで案件に何も書かない** — 最初の
 * 描画では fetch を 1 本も出さず、「確認する」を押して初めて plan を呼ぶ。
 * 参照切替は `register-assets`（新資産を文書へ）→ `replace-text-style-asset`（参照を移す）の 2 手。
 * ①を飛ばすと②は MISSING_TARGET で落ちるので、①が失敗したら②へ進まない。
 * 取り消しは Undo 1 回（旧資産は残してある）。
 */
export function NativeTelopPackUpdate(props: TelopPackUpdateProps) {
  const [plan, setPlan] = useState<PackPlanView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>('');

  // 計画の前提が変わったら捨てる（Codex P2-2）。前提は参照先だけではない — `gainingCount` も
  // `losingClipIds` も**字幕ごとの animation / template** から数えているので、参照先 assetId の
  // 集合だけを見ていると、確認後に動きやスタイルを変えても古い件数のまま押せてしまう（Codex 2 巡目 #5）。
  // 鍵は字幕 1 件につき (assetId, animation, template) の 1 項（並べ替えだけでは畳まないよう sort する）。
  // **文書は書き換えない**（読み取って自分の state を畳むだけ。選択の副作用で dirty にしない）。
  const referenceKey = useMemo(() => props.document.clips.flatMap(clip =>
    clip.content.kind === 'telop'
      ? [[textComponentId(props.document, clip.content) ?? '',
          String(clip.content.data.animation ?? ''), String(clip.content.data.template ?? '')].join('\u0000')]
      : []).sort().join('|'), [props.document]);
  const [seenReferenceKey, setSeenReferenceKey] = useState(referenceKey);
  if (seenReferenceKey !== referenceKey) { setSeenReferenceKey(referenceKey); setPlan(undefined); }
  // 送信時の前提を覚えておき、応答が返る前に文書が変わっていたらその応答を捨てる（最終レビュー N-2）。
  // 捨てないと、畳んだはずの古い計画が遅れて復活して「更新する」が押せる。
  const latestReferenceKey = useRef(referenceKey);
  latestReferenceKey.current = referenceKey;

  const check = async (): Promise<void> => {
    const requestedFor = referenceKey;
    setBusy(true);
    try {
      const response = await fetch(`/api/telop-pack-update/plan?id=${encodeURIComponent(props.projectId)}`, {method: 'POST'});
      // `extractErrorMessage(body: unknown): string`（`src/app/fetchJson.ts:19`）。**Response を渡して await する
      // API ではない**（事前検査 B の B9-3。渡すと tsc が落ちる）。先に JSON を読む。
      if (!response.ok) { setNotice(extractErrorMessage(await response.json().catch(() => null))); return; }
      const body = await response.json() as {plan: PackPlanView | null; reason?: string};
      if (latestReferenceKey.current !== requestedFor) return;   // 待っている間に文書が変わった＝この応答は古い
      setPlan(body.plan);
      if (body.plan === null) setNotice(UNAVAILABLE_NOTICE[body.reason ?? ''] ?? UNAVAILABLE_NOTICE['up-to-date']!);
    } finally { setBusy(false); }
  };

  const apply = async (): Promise<void> => {
    if (!plan) return;
    // 切替の起点が無い計画では何も切り替わらない。**成功を名乗らない**（レビュー I-1。
    // 旧実装は `onReplaceAsset` を飛ばしたうえで「更新しました」を出し、文書だけを dirty にした）。
    if (!plan.assetId) {
      setPlan(undefined);
      setNotice('この案件はまだ同梱テロップスタイルを使っていないので、更新するものがありません。');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/telop-pack-update/apply?id=${encodeURIComponent(props.projectId)}`, {method: 'POST'});
      if (!response.ok) { setNotice(extractErrorMessage(await response.json().catch(() => null))); return; }
      const {asset} = await response.json() as {asset: SequenceAsset};
      if (!await props.onRegisterAsset(asset)) { setNotice('新しいスタイルを登録できませんでした。もう一度お試しください。'); return; }
      if (!await props.onReplaceAsset(plan.assetId, asset.id)) {
        setNotice('登録はできましたが、字幕の参照を切り替えられませんでした。もう一度お試しください。'); return;
      }
      // `null` にすると確認ボタンも計画も消え、Undo で旧版へ戻しても再確認できない（Codex P2-2）。
      // `undefined` へ戻して確認ボタンを出し直す（成功通知はそのまま残る）。
      setPlan(undefined);
      setNotice(`テロップスタイルを ${plan.toVersion} に更新しました。元に戻すは 1 回で効きます。`);
    } finally { setBusy(false); }
  };

  return <section className="native-pack-update" aria-label="テロップスタイルの更新">
    {plan === undefined &&
      <button type="button" className="native-text-button" disabled={props.disabled || busy}
        onClick={() => void check()}>テロップスタイルの更新を確認する</button>}
    {plan && <div className="native-pack-update-plan" role="group" aria-label="テロップスタイルの更新内容">
      <p>いまの版 {plan.fromVersion} → {plan.toVersion}。この案件の字幕 {plan.captionCount}件が対象です。</p>
      <p>更新すると、これまで選んでも効かなかった動きが <strong>{plan.gainingCount}件</strong> の字幕で動き始めます。</p>
      {plan.losingClipIds.length > 0 &&
        <p className="native-pack-update-warn">{plan.losingClipIds.length}件の字幕は、選んでいる動きがこのスタイルでは使えなくなります。</p>}
      <p className="native-subtle">「なし」は追加のアニメーションなしのまま変わりません（スタイルごとの短いフェードは残ります）。元に戻すは 1 回で効きます。</p>
      <button type="button" disabled={props.disabled || busy} onClick={() => void apply()}>
        {busy ? '更新中…' : `${plan.captionCount}件を更新する`}</button>
      <button type="button" disabled={busy} onClick={() => setPlan(undefined)}>やめる</button>
    </div>}
    {notice && <p role="status" className="native-pack-update-notice">{notice}</p>}
  </section>;
}
