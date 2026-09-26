import { useCallback, useEffect, useRef, useState } from 'react';
import { HomeDashboardWithAgentBoard, type CreateSource } from '../panels/HomeDashboard';
import { useTheme } from '../layout/useTheme';
import { Icon } from '../Icon';
import { useEventBusProjectId } from '../eventBus';
import { useProjectsWatch } from '../useProjectsWatch';
import { mergeProjectSummaries, applyStatusPatch, type ProjectListEntry } from '../projectSummaries';
import { fetchJson, putJsonPost } from '../fetchJson';
import type { ProjectSummary } from '../../shared/types';
import type { ProjectStage } from '../../shared/projectStage';
import { HelpModal } from '../help/HelpModal';
import { TutorialOverlay } from '../tutorial/TutorialOverlay';
import { useNativeTutorial } from '../tutorial/useNativeTutorial';
import { NativeWorkspace } from './NativeWorkspace';
import { createNativeImageProject, createNativeProject } from './api';
import {useNativeFileReference} from './useNativeFileReference';
import './native.css';
import './native-polish.css';
import type {TransferProgress} from '../components/TaskProgress';

/** Keep the established project dashboard while making native editing the normal entry. */
export function NativeApp() {
  const projectId = new URLSearchParams(location.search).get('project');
  useEventBusProjectId(projectId ?? '');
  useEffect(() => {
    const prevent = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', prevent); window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);
  return projectId ? <NativeWorkspace key={projectId} projectId={projectId} /> : <NativeHome />;
}

/** 編集画面へ全ページ遷移する（テストでは NativeHome の navigate で差し替える）。 */
export function navigateToProject(id: string): void {
  location.assign(`/?${new URLSearchParams({ project: id })}`);
}

export function NativeHome({ navigate = navigateToProject }: { navigate?: (id: string) => void }) {
  const fileReference=useNativeFileReference();
  const theme = useTheme();
  const [projects, setProjects] = useState<ProjectListEntry[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false), generation = useRef(0), request = useRef<AbortController | null>(null);
  const stages = useRef(new Map<string, Promise<unknown>>());
  const [helpOpen, setHelpOpen] = useState(false);
  const refresh = useCallback(async () => {
    const current = ++generation.current; request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    try {
      const value = await fetchJson<{ projects: ProjectSummary[] }>('/api/projects', { signal: controller.signal });
      if (mounted.current && generation.current === current) {
        setProjects(previous => mergeProjectSummaries(previous, value.projects)); setError(null);
      }
    } catch (error) {
      if (mounted.current && generation.current === current && !controller.signal.aborted) setError(error instanceof Error ? error.message : String(error));
    } finally { if (mounted.current && generation.current === current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; generation.current++; request.current?.abort(); }; }, [refresh]);
  useProjectsWatch(true, (id, patch) => setProjects(previous => applyStatusPatch(previous, id, patch)), () => void refresh());
  const tutorial = useNativeTutorial({
    scene: 'home', projectId: null, documentId: null, hasProjects: projects.length > 0,
    ready: !loading, loadFailed: false, dirty: false,
  });
  /** 編集画面へ移る（作品カード・作成成功）。案内の表示中なら、遷移の直前に続きの手順を残す。 */
  const pick = (id: string) => { tutorial.beforeNavigate(id); navigate(id); };
  const setStage = (id: string, stage: ProjectStage) => {
    // Serialize rapid changes per project; never roll an older response over a newer choice.
    const task = (stages.current.get(id) ?? Promise.resolve()).then(async () => {
      await putJsonPost('/api/project/status', { id, stage }); await refresh();
    }).catch(error => { if (mounted.current) setNotice(error.message); });
    stages.current.set(id, task); void task.finally(() => { if (stages.current.get(id) === task) stages.current.delete(id); });
  };
  const create = async (name: string, source: CreateSource,preferCopy:boolean,onProgress?:(progress:TransferProgress)=>void) => {
    if (source.kind === 'upload-images' || source.kind === 'link-images') {
      const result = await createNativeImageProject(name, source.kind === 'upload-images' ? source.files : source.files.map(file => file.path), onProgress);
      pick(result.id); return;
    }
    const reference=source.kind==='upload'&&!preferCopy?await fileReference.resolve(source.file,onProgress):null;
    const result = await createNativeProject(name,reference?.path??(source.kind==='upload'?source.file:source.path),onProgress,reference?.expectedFingerprint);
    pick(result.id); // 作成成功 → 遷移の直前に再開位置を残す（失敗時はここへ来ないので残さない）
  };
  return <main className="native-home-app">
    <header className="native-header"><span className="native-brand">Harness <span>Editor</span></span>
      <div className="native-header-actions">
        <button className="native-home-icon" data-tutorial="help" aria-label="使い方（ヘルプ）" title="使い方（ヘルプ）" onClick={() => setHelpOpen(true)}><Icon name="question" /></button>
        <button className="native-home-icon" aria-label="テーマ切替" onClick={theme.toggle}><Icon name={theme.theme === 'dark' ? 'sun' : 'moon'} /></button>
      </div>
    </header>
    {error && <div className="native-notice" role="alert"><span>{error}</span><button onClick={() => void refresh()}>一覧を再読み込み</button></div>}
    <HomeDashboardWithAgentBoard managedMedia projects={projects} error={projects.length ? null : error} notice={notice} loading={loading} onPick={pick} onSetStage={setStage}
      onCreate={create} onProjectsChanged={() => void refresh()} />
    {fileReference.picker}
    {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} onRestartTutorial={() => { setHelpOpen(false); tutorial.start(); }} />}
    <TutorialOverlay tutorial={tutorial} options={tutorial.overlayOptions} />
  </main>;
}
