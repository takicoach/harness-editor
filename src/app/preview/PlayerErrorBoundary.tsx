import { Component, useEffect, type ReactNode } from 'react';

interface PlayerErrorBoundaryProps {
  /**
   * 値が変わると崩壊状態を解除して子を作り直す（プレビュー再読み込みの key）。
   * Preview の reloadKey をそのまま渡す。
   */
  resetKey: number;
  /** 「再読み込み」押下ハンドラ（App 側で reloadKey を進める）。 */
  onReload: () => void;
  children: ReactNode;
}

interface PlayerErrorBoundaryState {
  crashed: boolean;
  /** 直近に見た resetKey。変化を描画中に検出して crashed を落とす。 */
  seenKey: number;
}

/**
 * プレビュー（Remotion Player）の描画が落ちたときの復帰境界（QA C-2）。
 *
 * 素の Player は内部のエラー境界に落ちると 12px の絵文字だけを残し、文章での
 * 説明も復帰導線も無い。ここで先に受け止めて「何が起きたか・次に何をすればよいか」を
 * 文章で出し、「再読み込み」で Player を作り直せるようにする。
 * 再読み込みは onReload → App が resetKey を進める → 下の
 * getDerivedStateFromProps が crashed を解除、という 1 方向で完結する。
 */
export class PlayerErrorBoundary extends Component<PlayerErrorBoundaryProps, PlayerErrorBoundaryState> {
  constructor(props: PlayerErrorBoundaryProps) {
    super(props);
    this.state = { crashed: false, seenKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<PlayerErrorBoundaryState> {
    return { crashed: true };
  }

  static getDerivedStateFromProps(
    props: PlayerErrorBoundaryProps,
    state: PlayerErrorBoundaryState,
  ): Partial<PlayerErrorBoundaryState> | null {
    if (props.resetKey === state.seenKey) return null;
    // 再読み込みが押された（＝key が進んだ）。次の描画で子をやり直す。
    return { crashed: false, seenKey: props.resetKey };
  }

  render(): ReactNode {
    if (!this.state.crashed) return this.props.children;
    return <PreviewCrashPanel onReload={this.props.onReload} />;
  }
}

/**
 * 復帰パネル本体（QA C-2）。
 *
 * この境界だけでは足りない: Remotion の Player は内部にも ErrorBoundary を持ち、
 * Composition の描画例外はそちらが先に捕らえる（既定の errorFallback は '⚠️' の 1 文字）。
 * 外側の境界には伝播しないので、Preview 側でも崩壊を検知して同じ文章と復帰ボタンを出す。
 *
 * ただし **このパネルを errorFallback として直接返してはいけない**（サイクル 4 Codex 指摘 P2）。
 * errorFallback は動画解像度（例 1080×1920）のコンテナの中に描かれ、そのコンテナは
 * ステージに収まるよう CSS transform で縮小される。1080 幅を 324px で見せる縮尺だと
 * 12px の文字は実寸 3.6px、ボタンも同じ比率で潰れて読めず押せない。
 * errorFallback には最小のプレースホルダ（CompositionCrashProbe）だけを返し、
 * このパネルは縮小の外側＝`.pv-stage` 直下のオーバーレイとして出す。
 */
export function PreviewCrashPanel({ onReload }: { onReload: () => void }) {
  return (
    <div className="pv-crash" role="alert" data-testid="preview-crash">
      <p className="pv-crash-title">プレビューを表示できませんでした。</p>
      <p className="pv-crash-hint">
        「再読み込み」を押してください。直らない場合はアプリを起動し直してください。
        編集内容は失われません。
      </p>
      <button
        type="button"
        className="btn btn-secondary btn-sm pv-crash-reload"
        data-testid="preview-crash-reload"
        onClick={onReload}
      >
        ⟳ 再読み込み
      </button>
    </div>
  );
}

/**
 * Player の `errorFallback` に渡す最小プレースホルダ（サイクル 4 Codex 指摘 P2）。
 *
 * ここは動画解像度のコンテナの中＝CSS transform で縮小される領域なので、読ませる文章も
 * 押させるボタンも置かない。「崩壊した」という事実だけをマウント時に外へ伝え、
 * 実際の復帰パネルは縮小の外側（`.pv-stage` 直下）に出させる。
 */
export function CompositionCrashProbe({ onCrash }: { onCrash: () => void }) {
  useEffect(() => {
    onCrash();
  }, [onCrash]);
  return <div className="pv-crash-probe" data-testid="preview-crash-probe" aria-hidden="true" />;
}
