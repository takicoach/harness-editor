/** @vitest-environment jsdom */
import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import {cleanup,fireEvent,render,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {NativeWorkspace} from './NativeWorkspace';
import {SequenceSession} from '../../core/sequence/session';
import {fixture} from '../../core/sequence/fixtures';
import type {SequenceDocument} from '../../core/sequence/model';

// I2: 「外した素材」トレイは doc.assets と照合する。Undo で asset が文書へ戻ったら、
// トレイ（＝ゴミ箱ボタン）も一緒に消えなければならない（さもないと文書が参照するファイルをゴミ箱へ送れてしまう）。
function unusedAssetDoc(): SequenceDocument {
  const base = fixture();
  return { ...base, assets: [...base.assets, { id: 'unused', kind: 'media', file: 'public/se/unused.wav', name: '未使用素材', fingerprint: 'unused',
    streams: [{ index: 0, kind: 'audio', codec: 'aac', duration: { num: 1, den: 1 }, sampleRate: 48000, channels: 2 }] }] };
}
vi.mock('./NativePreview', () => ({ NativePreview: forwardRef((_p: any, ref) => { useImperativeHandle(ref, () => ({ pause() {}, flushManipulation: async () => true })); return null; }) }));
vi.mock('./NativeInspector', () => ({ NativeInspector: forwardRef((_p: any, ref) => { useImperativeHandle(ref, () => ({ flush: async () => true })); return null; }) }));
vi.mock('./NativeTimeline', () => ({ NativeTimeline: forwardRef(() => null) }));
vi.mock('./NativeScriptPanel', () => ({ NativeScriptPanel: forwardRef(() => null) }));
vi.mock('./NativeExportControl', () => ({ NativeExportControl: () => null }));
vi.mock('./NativeTranscribeControl', () => ({ NativeTranscribeControl: () => null }));
vi.mock('../useAutoSave', () => ({ useAutoSave: () => {} }));
vi.mock('../layout/useTheme', () => ({ useTheme: () => ({ theme: 'dark', toggle() {} }) }));
vi.mock('../useEditorAgentConnection', () => ({ useEditorAgentConnection: () => ({ connection: 'disconnected' }) }));
vi.mock('./useNativeEditorBridge', () => ({ useNativeEditorBridge: () => ({ bridge: {}, busy: false }) }));
// 実際の SequenceSession（remove-asset / undo の本物の判定・履歴）に配線した最小限のセッションフック。
// command() 経路（session.execute）と readCurrent() の両方が同じインスタンスを見る必要があるため、
// ここだけは他のテストのようにベタな戻り値ではなく React state を持つ実フックとして実装する。
vi.mock('./useNativeSession', () => ({
  useNativeSession: (projectId: string) => {
    const sessionRef = useRef<SequenceSession | null>(null);
    const [state, setState] = useState<{ sessionId: string; dirty: boolean; document: SequenceDocument; canUndo: boolean; canRedo: boolean } | null>(null);
    useEffect(() => { sessionRef.current = new SequenceSession('s', unusedAssetDoc()); setState({ sessionId: 's', dirty: false, document: sessionRef.current.document, canUndo: false, canRedo: false }); }, [projectId]);
    const execute = async (command: any) => {
      const session = sessionRef.current; if (!session || !state) return false;
      session.execute({ sessionId: 's', executionId: `e${Math.random()}`, expectedRevision: session.document.revision, command });
      setState({ sessionId: 's', dirty: true, document: session.document, canUndo: session.canUndo, canRedo: session.canRedo });
      return true;
    };
    return { state, busy: false, execute, readCurrent: () => sessionRef.current && { sessionId: 's', dirty: false, document: sessionRef.current.document },
      save: async () => true };
  },
}));
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: 'unchanged', autoSaveDefaultEnabled: false }) })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('Undo で文書へ戻った素材は、外した素材トレイからも消える（ゴミ箱ボタンごと）', async () => {
  const view = render(<NativeWorkspace projectId="tray" />);
  fireEvent.click(view.getByRole('tab', { name: '素材' }));
  // B: 素材一覧は 4 タブ。未使用素材は public/se/ なので「効果音」タブに並ぶ。
  fireEvent.click(view.getByRole('tab', { name: '効果音 1' }));
  fireEvent.click(await view.findByRole('button', { name: '未使用素材を案件から外す' }));
  await waitFor(() => expect(view.getByRole('button', { name: '未使用素材のファイルをゴミ箱へ移す' })).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: '元に戻す' }));
  await waitFor(() => expect(view.queryByRole('button', { name: '未使用素材のファイルをゴミ箱へ移す' })).toBeNull());
  expect(view.queryByText('案件から外した素材（ファイルは案件フォルダに残っています）')).toBeNull();
});
