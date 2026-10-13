import { useState } from 'react';
import type { InstructionStatus } from '../../../shared/types';
import { Icon } from '../../Icon';
import { AiTerminal } from '../../panels/AiTerminal';
import { focusAiTerminal } from '../../panels/aiTerminalFocus';
import type { AiFocusHandle } from '../../useAiFocus';
import type { SlidesRequestIntent } from './requestIntent';
import type { SlidesAgentHook } from './useSlidesAgent';
import type { SlidesSessionHook } from './useSlidesSession';

const RECORD_STATUS: Readonly<Record<InstructionStatus, string>> = { pending: '送信待ち（Enter で送ります）', processing: '作業中', done: '終わりました', failed: '止まりました' };
/** 右の「AI の作業」: 接続の状態・最後の依頼・止まったときの案内と、AI の端末（欄を開くと AI が起動する）。 */
export function SlidesAiPanel({ agent, session, focus, onPaste, onToast, onClose }: {
  agent: SlidesAgentHook; session: SlidesSessionHook; focus: AiFocusHandle; onPaste(intent: SlidesRequestIntent): void; onToast(message: string): void; onClose(): void;
}) {
  const [working, setWorking] = useState(false), health = agent.health;
  const resume = async () => {
    setWorking(true);
    try {
      await agent.abort();
      const generation = session.readCurrent()?.document.generation;
      if (generation?.status === 'cancelled' && !await session.execute({ type: 'resume-generation', runId: generation.runId })) return;
      const intent = agent.continueIntent();
      if (!intent) { onToast('残っているページはありません'); return; }
      await agent.send(intent);
    } finally { setWorking(false); }
  };
  const toPaste = async () => {
    await agent.abort();
    const intent = agent.continueIntent() ?? agent.lastIntent;
    if (!intent) { onToast('先に左の「台本から作る」で台本を段落に分けてください'); return; }
    onPaste(intent);
  };
  return <aside className="native-thumbnail-knobs native-slides-ai" aria-label="AI の作業">
    <header className="native-thumbnail-knobs-head"><strong>AI の作業</strong>
      <button type="button" className="btn-ghost native-header-icon" aria-label="AI の作業を閉じる" title="閉じる" onClick={onClose}><Icon name="x" /></button></header>
    <p className="native-slides-ai-state" data-state={health.state} role="status">{health.message}</p>
    {agent.record && <p className="native-thumbnail-note">最後の依頼: {RECORD_STATUS[agent.record.status]}（{new Date(agent.record.updatedAt).toLocaleTimeString('ja-JP')}）</p>}
    {agent.error && <p className="native-slides-dialog-error" role="alert">{agent.error}</p>}
    {health.actions.length > 0 && <div className="native-slides-row">
      {health.actions.includes('reconnect') && <button type="button" className="btn-secondary" onClick={focusAiTerminal}>AI の画面を見る</button>}
      {health.actions.includes('resume') && <button type="button" className="btn-primary" disabled={working || session.busy} onClick={() => void resume()}>続きから作る</button>}
      {health.actions.includes('paste') && <button type="button" className="btn-secondary" disabled={working} onClick={() => void toPaste()}>貼り付けに切り替える</button>}
    </div>}
    <div className="native-slides-ai-terminal"><AiTerminal focus={focus} /></div>
  </aside>;
}
