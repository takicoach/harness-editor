import { useCallback, useRef } from 'react';
import { useEventBusProjectId } from '../../eventBus';
import { loadAutoSaveEnabled } from '../../layout/autoSavePref';
import { useAutoSave } from '../../useAutoSave';
import { SlidesRecovery } from './SlidesRecovery';
import { SlidesWorkspace } from './SlidesWorkspace';
import { useSlidesSession } from './useSlidesSession';
import '../native.css';
import '../native-polish.css';
import '../thumbnail/thumbnail.css';
import './slides.css';

/** スライド案件の画面（/?slides=<名前>）。動画の編集画面とは別の入口。 */
export function SlidesApp({ slidesId }: { slidesId: string }) {
  useEventBusProjectId(slidesId);
  const session = useSlidesSession(slidesId), flushers = useRef(new Set<() => Promise<boolean>>());
  // 入力中の値（その場の文字編集・話すメモ）を確定させてから保存する。
  const flush = useCallback(async () => { for (const item of [...flushers.current]) if (!await item()) return false; return true; }, []);
  const save = useCallback(async () => await flush() && await session.save(), [flush, session.save]);
  useAutoSave({ enabled: loadAutoSaveEnabled() && !!session.state && !session.state.externalChange, dirty: session.state?.dirty ?? false,
    saveStatus: session.busy ? 'saving' : session.error ? 'error' : 'idle', state: session.state?.document, save });
  // ホームへ戻る: 入力中の値を確定させ、未保存なら保存してから。失敗したら離れない（編集はそのまま残す）。
  const goHome = useCallback(async () => {
    if (!await flush()) return;
    if (session.readCurrent()?.dirty && !await session.save()) return;
    location.assign('/');
  }, [flush, session.readCurrent, session.save]);
  return <main className="native-slides-app native-workspace">
    {session.phase === 'broken' && session.broken
      ? <SlidesRecovery session={session} broken={session.broken} onHome={() => location.assign('/')} />
      : session.phase === 'error' && !session.state
        ? <section className="native-slides-recovery" role="alert"><h2>スライドを開けませんでした</h2><p>{session.error}</p>
            <button type="button" className="btn-secondary" onClick={() => location.assign('/')}>ホームへ戻る</button></section>
        : <SlidesWorkspace projectId={slidesId} session={session} flushers={flushers.current} onSave={save} onHome={() => void goHome()} />}
  </main>;
}
