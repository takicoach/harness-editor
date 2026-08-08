import { useAgentConnected } from '../useAgentConnected';
import { resolveTarget, resolveText } from './tutorialMachine';
import type { TutorialApi } from './useTutorial';

/**
 * チュートリアルの描画層。暗幕（照準くり抜き）＋マスコット付き吹き出し＋紙吹雪。
 * オーバーレイ全体は pointer-events: none（吹き出しのみ操作可）なので、
 * 実操作ステップでは照準のボタンをそのまま押せるし、ユーザーを閉じ込めない。
 */
export function TutorialOverlay({ tutorial }: { tutorial: TutorialApi }) {
  const { step, ctx } = tutorial;
  // MCP ステップ表示中だけ接続状態をポーリング（接続済みなら手順を出さない）。
  const agentConnected = useAgentConnected(step?.body === 'mcp');
  if (!tutorial.active || step === null) return null;

  const selector = resolveTarget(step, ctx);
  const el = selector !== null ? document.querySelector(selector) : null;
  const rect = el?.getBoundingClientRect() ?? null;
  const text = resolveText(step, ctx);
  const party = step.body === 'party';

  // 吹き出しの位置: 照準の下に置き、入らなければ上へ。照準なしは中央。
  const bubbleStyle: React.CSSProperties = {};
  if (rect === null) {
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

  const secondary = step.secondary === null ? null : (step.secondary ?? { label: 'スキップ', action: 'skip' as const });

  return (
    <div className="tut" data-step={step.id}>
      {/* 暗幕。照準があればその矩形をくり抜く（box-shadow 方式・クリック透過）。 */}
      {rect !== null ? (
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
          <span className="tut-eye l" />
          <span className="tut-eye r" />
          <span className="tut-mouth" />
        </div>
        <div className="tut-body">
          <p className="tut-text">{text}</p>
          {step.body === 'mcp' && (
            <div className="tut-mcp">
              {agentConnected.global === true ? (
                <p className="tut-mcp-ok">接続済みですね！ このまま進みましょう。</p>
              ) : (
                <p className="cl-setup-note">
                  動画を開いたら「AI」タブ →「AI と接続する（Claude Code を導入）」→ ログイン →
                  「待機を開始（編集指示を受け付ける）」の順に押すだけです（初回のみ導入とログインが必要）。
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
              {(step.nextButton ?? true) && (
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
