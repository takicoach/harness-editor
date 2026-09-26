import { useAgentConnected } from '../useAgentConnected';
import { useFeatureBadge } from '../useFeatureBadge';
import { resolveTarget, resolveText } from './tutorialMachine';
import type { TutorialApi } from './useTutorial';
import guideMascot from './assets/guide-mascot.png';

/** 照準の矩形（DOMRect の必要な部分だけ）。 */
export interface TutorialRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * 新画面（native）だけが渡す追加指定。渡さない旧画面は従来どおり描画する（DOM 属性も増やさない）。
 */
export interface TutorialOverlayOptions {
  /** true の間は何も描かない（ダイアログ表示中・読み込み失敗・画面を整えている間）。 */
  hidden?: boolean;
  /** 指定時は暗幕と吹き出しの代わりに、最前面・クリック透過の1行案内帯だけを出す（作成ダイアログ表示中）。 */
  band?: string | null;
  /** 指定時は照準を持たず、暗幕なしで画面下に準備待ちの吹き出しを出す（「次へ」「スキップ」は出さない）。 */
  waiting?: string | null;
  /** 照準の矩形。null＝見えない・押せない → 中央に unavailableText を出し、「次へ」を必ず出す。 */
  locate?: (selector: string) => TutorialRect | null;
  unavailableText?: string;
}

/**
 * チュートリアルの描画層。暗幕（照準くり抜き）＋マスコット付き吹き出し＋紙吹雪。
 * オーバーレイ全体は pointer-events: none（吹き出しのみ操作可）なので、
 * 実操作ステップでは照準のボタンをそのまま押せるし、ユーザーを閉じ込めない。
 */
export function TutorialOverlay({ tutorial, options }: { tutorial: TutorialApi; options?: TutorialOverlayOptions }) {
  const { step, ctx } = tutorial;
  // MCP ステップ表示中だけ接続状態をポーリング（接続済みなら手順を出さない）。
  const agentConnected = useAgentConnected(step?.body === 'mcp');
  // 新機能を説明するステップは、初めて見た回だけ吹き出しに NEW バッジを出す（見た時点で既読）。
  const showNew = useFeatureBadge(step?.id ?? null, step?.addedIn);
  if (!tutorial.active || step === null) return null;
  if (options?.hidden) return null;
  if (options?.band) {
    return <p className="tut-band" role="status" data-step={step.id}>{options.band}</p>;
  }

  const waiting = options?.waiting ?? null;
  const selector = waiting === null ? resolveTarget(step, ctx) : null;
  let rect: TutorialRect | null = null;
  if (selector !== null) {
    rect = options?.locate ? options.locate(selector) : (document.querySelector(selector)?.getBoundingClientRect() ?? null);
  }
  const unavailable = selector !== null && rect === null && options?.locate !== undefined;
  const text = waiting ?? (unavailable ? (options?.unavailableText ?? resolveText(step, ctx)) : resolveText(step, ctx));
  const party = waiting === null && step.body === 'party';

  // 吹き出しの位置: 照準の下に置き、入らなければ上へ。照準なしは中央。準備待ちは下端中央。
  const bubbleStyle: React.CSSProperties = {};
  if (waiting !== null) {
    // 「編集を始める」など画面中央の既存操作を覆わないよう、下端に置く。
    bubbleStyle.left = '50%';
    bubbleStyle.bottom = 24;
    bubbleStyle.transform = 'translateX(-50%)';
  } else if (rect === null) {
    bubbleStyle.left = '50%';
    bubbleStyle.top = '42%';
    bubbleStyle.transform = 'translate(-50%, -50%)';
  } else {
    const bubbleW = 360;
    const bubbleH = 180; // 概算。画面外クランプ用
    const below = rect.bottom + 14;
    const top =
      step.placement === 'above'
        ? Math.max(12, rect.top - bubbleH - 14) // ドロップダウンが下へ開くステップはメニューと重ねない
        : below + bubbleH < window.innerHeight
          ? below
          : Math.max(12, rect.top - bubbleH - 14);
    const left = Math.min(Math.max(12, rect.left + rect.width / 2 - bubbleW / 2), window.innerWidth - bubbleW - 12);
    bubbleStyle.left = left;
    bubbleStyle.top = top;
  }

  const secondary =
    waiting !== null || step.secondary === null ? null : (step.secondary ?? { label: 'スキップ', action: 'skip' as const });
  const showNext = waiting === null && (unavailable || (step.nextButton ?? true));

  // 新画面（options 指定あり）だけ滑らかな動きを付ける。旧画面の描画・DOM は変えない（既存の約束）。
  const isNative = options !== undefined;

  return (
    <div
      className={'tut' + (isNative ? ' tut-native' : '')}
      data-step={step.id}
      data-waiting={waiting !== null ? 'true' : undefined}
      data-target={options !== undefined && selector !== null ? selector : undefined}
    >
      {/* 暗幕。照準があればその矩形をくり抜く（box-shadow 方式・クリック透過）。準備待ちは暗幕なし。
          新画面は「くり抜きなし」の状態も同じ .tut-hole 要素（画面全体を覆う矩形）で表すことで、
          .tut-dim との入れ替わりを起こさず、暗幕がそのまま滑らかに動く。 */}
      {waiting !== null ? null : isNative ? (
        <div
          className={'tut-hole' + (rect === null ? ' tut-hole--full' : '')}
          style={
            rect !== null
              ? { left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }
              : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
          }
        />
      ) : rect !== null ? (
        <div
          className="tut-hole"
          style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      ) : (
        <div className="tut-dim" />
      )}

      {party && <Confetti />}

      <div className="tut-bubble" style={bubbleStyle} role="dialog" aria-label="チュートリアル">
        <div className={'tut-mascot' + (party ? ' party' : '')} aria-hidden="true">
          <img src={guideMascot} alt="" width={64} height={96} draggable={false} decoding="async" />
        </div>
        <div className="tut-body" key={step.id}>
          {showNew && <span className="tut-new-badge" aria-label="新機能">NEW</span>}
          <p className="tut-text">{text}</p>
          {step.body === 'mcp' && (
            <div className="tut-mcp">
              {agentConnected.global === true ? (
                <p className="tut-mcp-ok">接続済みですね！ このまま進みましょう。</p>
              ) : (
                <p className="cl-setup-note">
                  動画を開いて「AI」タブを押すだけです。まだ AI が入っていなければ
                  「AI と接続する（Claude Code を導入）」ボタンが出るので、導入 → ログインまで進めてください
                  （すでに入っていれば、この画面は出ずにそのまま繋がります）。最後に
                  「待機を開始（編集指示を受け付ける）」を押すと、指示を受け付ける状態になります。
                </p>
              )}
            </div>
          )}
          <div className="tut-foot">
            <span className="tut-progress">{tutorial.index} / {tutorial.total}</span>
            <span className="tut-actions">
              {secondary !== null && (
                <button
                  type="button"
                  className="tut-skip"
                  onClick={secondary.action === 'close' ? tutorial.close : tutorial.skip}
                >
                  {secondary.label}
                </button>
              )}
              {showNext && (
                <button type="button" className="tut-next" onClick={tutorial.next}>
                  {step.nextLabel ?? '次へ'}
                </button>
              )}
            </span>
          </div>
        </div>
        <button type="button" className="tut-close" title="チュートリアルを閉じる" aria-label="チュートリアルを閉じる" onClick={tutorial.close}>
          ×
        </button>
      </div>
    </div>
  );
}

const CONFETTI_COLORS = ['#E08D6D', '#5a9de0', '#e0719e', '#3fb27a', '#f0a020', '#a070e0'];

/** 紙吹雪。index ベースの擬似乱数で配置（再レンダーで揺れない・Math.random 不使用）。 */
function Confetti() {
  const pieces = Array.from({ length: 28 }, (_, i) => {
    const left = ((i * 37) % 100);
    const delay = ((i * 53) % 40) / 100;
    const duration = 1.3 + ((i * 29) % 60) / 100;
    const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    const rot = (i * 97) % 360;
    return (
      <i
        key={i}
        style={{
          left: `${left}%`,
          animationDelay: `${delay}s`,
          animationDuration: `${duration}s`,
          background: color,
          transform: `rotate(${rot}deg)`,
        }}
      />
    );
  });
  return <div className="tut-confetti" aria-hidden="true">{pieces}</div>;
}
