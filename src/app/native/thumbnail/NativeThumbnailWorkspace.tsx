import { forwardRef, useImperativeHandle, useRef } from 'react';
import type { SequenceDocument } from '../../../core/sequence/model';
import { TaskProgress } from '../../components/TaskProgress';
import { ThumbnailEditorView } from './ThumbnailEditorView';
import { ThumbnailRecovery } from './ThumbnailRecovery';
import type { ThumbnailExportHook } from './useThumbnailExport';
import type { ThumbnailSessionHook } from './useThumbnailSession';
import './thumbnail.css';

export interface ThumbnailWorkspaceHandle { flush(): Promise<boolean> }
export interface NativeThumbnailWorkspaceProps {
  projectId: string; session: ThumbnailSessionHook; videoDocument: SequenceDocument; pageId: string | null; onPage(pageId: string): void; onToast(message: string): void;
  /** 書き出しの状態（ワークスペース側で持つ）。下の帯の「すべての案を書き出す」が使う。 */
  exporter: ThumbnailExportHook;
  /** 右端の AI の列を開く。 */
  onOpenAi(): void;
}

/** フックは先頭だけ（早期 return の前）。読み込み中・壊れたときの選択を出し、文書があれば本体を描く。 */
export const NativeThumbnailWorkspace = forwardRef<ThumbnailWorkspaceHandle, NativeThumbnailWorkspaceProps>(function NativeThumbnailWorkspace({ projectId, session, videoDocument, pageId, onPage, onToast, exporter, onOpenAi }, ref) {
  // 入力中の値（その場文字編集など）を確定させる関数の登録先。保存・画面を離れる前に呼ぶ。
  const flushers = useRef(new Set<() => Promise<boolean>>());
  useImperativeHandle(ref, () => ({ async flush() { for (const flush of [...flushers.current]) if (!await flush()) return false; return true; } }), []);
  if (session.phase === 'broken' && session.broken) return <ThumbnailRecovery session={session} broken={session.broken} />;
  const document = session.state?.document;
  if (!document) return <section className="native-thumbnail native-thumbnail-loading" aria-busy={session.phase !== 'error'}>
    {session.phase === 'error' ? <p className="native-thumbnail-note" role="alert">{session.error ?? 'サムネを読み込めませんでした'}</p> : <TaskProgress label="サムネを読み込んでいます…" />}
  </section>;
  return <ThumbnailEditorView projectId={projectId} session={session} document={document} videoDocument={videoDocument} exporter={exporter} pageId={pageId}
    onPage={onPage} onToast={onToast} flushers={flushers.current} onOpenAi={onOpenAi} />;
});
