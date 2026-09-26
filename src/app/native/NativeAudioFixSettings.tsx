import { useCallback, useEffect, useState } from 'react';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import type { NativeCommand } from './api';
import { TaskProgress } from '../components/TaskProgress';

type Fix = 'denoise' | 'normalize';
/** `origin` は import 由来（音楽・効果音）も入る union。系譜を辿るのは audio-fix の枝だけ。 */
const fixOrigin = (asset: SequenceAsset | undefined): { from: string; fix: Fix } | undefined =>
  asset?.origin?.kind === 'audio-fix' ? asset.origin : undefined;
const LABEL: Record<Fix, string> = { denoise: 'ノイズ除去', normalize: '音量正規化' };
const SHORT: Record<Fix, string> = { denoise: '除去', normalize: '正規化' };
const WORKING: Record<Fix, string> = { denoise: 'ノイズを除去しています…', normalize: '音量をそろえています…' };

interface Props {
  projectId: string;
  document: SequenceDocument;
  /** 補正中に文書が進んだかを見るための現在値。省略時は表示中の文書を現在値とみなす。 */
  readDocument?(): SequenceDocument | null;
  disabled: boolean;
  exporting: boolean;
  onEdit(build: (current: SequenceDocument) => NativeCommand): Promise<boolean>;
  onRegister(assetIds: string[]): Promise<boolean>;
  onNotice(message: string): void;
}

/**
 * 調整タブの「案件全体」。対象は原音トラックの asset。
 * 既存 asset は上書きせず、別の不変 asset を登録して参照を切り替える（裁定 P0-1）。
 */
export function NativeAudioFixSettings({ projectId, document: doc, readDocument, disabled, exporting, onEdit, onRegister, onNotice }: Props) {
  const [busy, setBusy] = useState<Fix | null>(null);
  // T29 Minor: 戻す操作の実行中は、確定するまで次の戻すを受け付けない。
  const [reverting, setReverting] = useState(false);
  // I2: リロードやブラウザ間で走った補正も見えるよう、マウント時と実行中はサーバー側の状態を追従する。
  // （M-7: 待機中は 1 回だけ。実行中＝busy か remote が立っている間だけ 400ms で追従する。）
  const [remote, setRemote] = useState<Fix | null>(null);
  const poll = useCallback((signal: AbortSignal, accept: (value: Fix | null) => void) => {
    fetch(`/api/audio-fix/status?${new URLSearchParams({ id: projectId })}`, { signal })
      .then(response => response.json() as Promise<{ running?: Fix | null }>)
      .then(body => accept(body.running ?? null))
      .catch(() => undefined);
  }, [projectId]);
  // マウント時（と案件の切替時）に 1 回だけ読む。
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    poll(controller.signal, value => { if (active) setRemote(value); });
    return () => { active = false; controller.abort(); };
  }, [poll]);
  // M-7: 待機中まで 400ms ごとに叩き続けない。この製品は Vite dev サーバー自身が本体で
  // Node は単一スレッドなので、開いているだけのタブがサーバーの取り分を削る。
  // 実行中（自タブ busy／他タブ remote）のあいだだけ追従する。
  const running = busy !== null || remote !== null;
  useEffect(() => {
    if (!running) return;
    let active = true;
    const controller = new AbortController();
    const timer = setInterval(() => poll(controller.signal, value => { if (active) setRemote(value); }), 400);
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [poll, running]);
  const speech = doc.clips.find(clip => clip.content.kind === 'audio' && clip.content.role === 'speech');
  const content = speech?.content.kind === 'audio' ? speech.content : null;
  const asset = content ? doc.assets.find(item => item.id === content.assetId) : undefined;
  // 系譜: 原本 →（補正）→（補正）。origin.from を辿って何が掛かっているか読む。
  const chain: Fix[] = [];
  for (let current = asset, origin = fixOrigin(current); origin; origin = fixOrigin(current)) {
    chain.unshift(origin.fix);
    if (chain.length > doc.assets.length) break; // 壊れた記録で回り続けない
    current = doc.assets.find(item => item.id === origin.from);
  }
  const source = (() => {
    let current = asset, guard = doc.assets.length;
    for (let origin = fixOrigin(current); origin && guard-- > 0; origin = fixOrigin(current))
      current = doc.assets.find(item => item.id === origin.from);
    return current;
  })();
  const previous = asset?.origin?.kind === 'audio-fix' ? asset.origin.from : null;

  const swap = (toAssetId: string): Promise<boolean> => {
    if (!asset || !speech) return Promise.resolve(false);
    // T29 Minor: 連打すると props の再描画より先に 2 回目が飛び、1 回目で入れ替わった後の
    // document に対して古い fromAssetId を送って偽のエラーになる。送る直前に最新の
    // document から今の参照元を引き直し、既に目的の素材ならそのまま成功として扱う。
    const current = readDocument?.() ?? doc;
    const track = current.clips.find(clip => clip.id === speech.id);
    const from = track?.content.kind === 'audio' ? track.content.assetId : asset.id;
    if (from === toAssetId) return Promise.resolve(true);
    return onEdit(() => ({ type: 'replace-audio-source', trackId: speech.trackId, fromAssetId: from, toAssetId }));
  };

  const run = async (kind: Fix) => {
    if (!asset || !speech || busy) return;
    const before = (readDocument?.() ?? doc).revision;
    setBusy(kind);
    try {
      const response = await fetch(`/api/audio-fix?${new URLSearchParams({ id: projectId })}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: asset.id, kind }),
      });
      const body = await response.json().catch(() => ({} as { error?: string; asset?: { id: string } }));
      if (!response.ok || !body.asset?.id) {
        onNotice(`${body.error ?? '音声を補正できませんでした。'} 元の音声のままです。ffmpeg の用意と保存先の空きを確認して、もう一度「${LABEL[kind]}を実行」を押してください。`);
        return;
      }
      // 補正中に編集が進んでいたら勝手に差し替えない（人の操作の上に重ねない）。
      if ((readDocument?.()?.revision ?? before) !== before) {
        onNotice(`${LABEL[kind]}は終わりましたが、その間に編集が進んだため切り替えていません。元の音声のままです。もう一度「${LABEL[kind]}を実行」を押すと切り替わります。`);
        return;
      }
      // 順序が肝: asset を document に登録してから参照を切り替える。逆だと参照先が無い瞬間ができる。
      if (!await onRegister([body.asset.id])) {
        onNotice(`補正した音声を案件に取り込めませんでした。元の音声のままです。もう一度「${LABEL[kind]}を実行」を押してください。`);
        return;
      }
      if (!await swap(body.asset.id))
        onNotice(`補正した音声へ切り替えられませんでした。元の音声のままです。補正した音声は素材一覧に残っています。もう一度「${LABEL[kind]}を実行」を押してください。`);
    } catch (error) {
      onNotice(`${error instanceof Error ? error.message : '音声を補正できませんでした。'} 元の音声のままです。もう一度「${LABEL[kind]}を実行」を押してください。`);
    } finally { setBusy(null); }
  };

  const revert = (toAssetId: string | null | undefined) => {
    if (!toAssetId || reverting) return;
    setReverting(true);
    void swap(toAssetId).then(ok => { if (!ok) onNotice('元の音声へ戻せませんでした。今の音声のままです。もう一度お試しください。'); })
      .catch(() => onNotice('元の音声へ戻せませんでした。今の音声のままです。もう一度お試しください。'))
      .finally(() => setReverting(false));
  };

  // busy（自分の操作）が無いのに remote が立っている＝他クライアントかリロード前の実行が続いている。
  const remoteText = !busy && remote ? `実行中（${LABEL[remote]}）` : null;
  const locked = disabled || exporting || busy !== null || remote !== null || reverting;
  const statusText = exporting ? '書き出し中は音声を補正できません。書き出しが終わってからお試しください。'
    : remoteText ? remoteText
    : chain.length ? `${chain.map(fix => LABEL[fix]).join('と')}を適用しています。元の音声は残っています。` : null;
  return <fieldset className="native-audio-fix" disabled={disabled}><section data-setting="audio">
    <h3>音声の補正</h3>
    {!asset || !source ? <p className="native-subtle">原音のトラックがありません。</p> : <>
      <p className="native-subtle">主音声「{source.name}」に掛けます。元の音声は残り、いつでも戻せます。</p>
      {statusText && <p role="status">{statusText}</p>}
      <div className="native-audio-fix-actions">
        <button type="button" disabled={locked || chain.includes('denoise')} onClick={() => void run('denoise')}>ノイズ除去を実行</button>
        <button type="button" disabled={locked || chain.includes('normalize')} onClick={() => void run('normalize')}>音量正規化を実行</button>
      </div>
      {busy && <TaskProgress label={WORKING[busy]} compact />}
      {chain.length >= 2 && <div className="native-audio-fix-actions">
        <button type="button" disabled={locked} onClick={() => revert(previous)}>{SHORT[chain[chain.length - 1]!]}だけ戻す（{SHORT[chain[chain.length - 2]!]}済みへ）</button>
        <button type="button" disabled={locked} onClick={() => revert(source.id)}>両方戻す（原本へ）</button>
      </div>}
      {chain.length === 1 && <div className="native-audio-fix-actions">
        <button type="button" disabled={locked} onClick={() => revert(source.id)}>原本へ戻す</button>
      </div>}
    </>}
  </section></fieldset>;
}
