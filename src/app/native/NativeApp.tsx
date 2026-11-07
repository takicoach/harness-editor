import { useCallback, useEffect, useRef, useState } from 'react';
import { HomeDashboardWithAgentBoard, type CreateManyResult, type CreateSource } from '../panels/HomeDashboard';
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
import { createNativeEmptyProject, createNativeImageProject, createNativeProject } from './api';
import {createFolderProject,folderProjectNotes,waitForImportPrepared} from './createFolderProject';
import {useNativeFileReference} from './useNativeFileReference';
import './native.css';
import './native-polish.css';
import type {TransferProgress} from '../components/TaskProgress';
import {useNativeNavigation} from './useNativeNavigation';
import { SlidesHomeSection } from './slides/SlidesHomeSection';

/** Keep the established project dashboard while making native editing the normal entry. */
export function NativeApp() {
  const navigation = useNativeNavigation(), {projectId} = navigation;
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  useEventBusProjectId(projectId ?? '');
  useEffect(() => {
    const prevent = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    window.addEventListener('dragover', prevent); window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);
  return projectId ? <NativeWorkspace key={`${projectId}:${workspaceVersion}`} projectId={projectId} navigation={navigation} onReload={()=>setWorkspaceVersion(value=>value+1)} /> : <NativeHome navigate={id=>void navigation.navigate(id)} />;
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
  const create = async (name: string, source: CreateSource,preferCopy:boolean,onProgress?:(progress:TransferProgress)=>void,onStep?:(index:number,count:number)=>void):Promise<void|CreateManyResult> => {
    if (source.kind === 'empty') { const result = await createNativeEmptyProject(name); pick(result.id); return; }
    if (source.kind === 'video-projects') {
      // 1 本ずつ単発の作成を順に呼び、どれも開かない（作り終えたらホームに留まる。設計 3-3）。1 本の失敗で残りを止めない。
      const result: CreateManyResult = { created: [], failed: [], stopped: [] };
      for (const [index, file] of source.files.entries()) {
        const projectName = source.names[index]!;
        onStep?.(index + 1, source.files.length);
        try {
          const reference = preferCopy ? null : await fileReference.resolve(file, onProgress);
          const created = await createNativeProject(projectName, reference?.path ?? file, onProgress, reference?.expectedFingerprint);
          result.created.push(created.id);
        } catch (error) {
          // 保存場所の選択を取り消したら残りは作らない（選択が本数分開き続けないように）。
          if ((error as { name?: string } | null)?.name === 'AbortError') { result.stopped.push(...source.names.slice(index)); break; }
          result.failed.push({ name: projectName, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    }
    if (source.kind === 'folders') {
      // フォルダごとに 1 プロジェクト。動画の準備が終わるまで待ってからトップに留まる（準備済みの束は再起動しても残り、開いた時に素材欄へ入る）。
      const result: CreateManyResult = { created: [], failed: [], stopped: [], unit: 'folder', notes: [] };
      for (const [index, folder] of source.folders.entries()) {
        const projectName = source.names[index]!;
        onStep?.(index + 1, source.folders.length);
        try {
          const made = await createFolderProject(projectName, folder, preferCopy, fileReference, onProgress);
          result.created.push(made.id);
          onProgress?.({ phase: 'preparing' });
          result.notes!.push(...folderProjectNotes(projectName, made, await waitForImportPrepared(made.id, made.batchId)));
          if (made.aborted) { result.stopped.push(...source.names.slice(index + 1)); break; }
        } catch (error) {
          // 保存場所の選択を取り消したら残りは作らない（選択が本数分開き続けないように）。
          if ((error as { name?: string } | null)?.name === 'AbortError') { result.stopped.push(...source.names.slice(index)); break; }
          result.failed.push({ name: projectName, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    }
    if (source.kind === 'folder') {
      const made = await createFolderProject(name, source, preferCopy, fileReference, onProgress);
      // 全ページ遷移で通知が消えるので、書類の失敗があれば開かずにトップで見せる。
      // 開かずに留まる時は、複数フォルダと同じく準備が終わるまで待つ（準備中の動画は再起動で失敗に変わるため）。
      if (made.documentFailures.length) {
        onProgress?.({ phase: 'preparing' });
        return { created: [made.id], failed: [], stopped: [], unit: 'folder', notes: folderProjectNotes(name, made, await waitForImportPrepared(made.id, made.batchId)) };
      }
      pick(made.id); return;
    }
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
      onCreate={create} onProjectsChanged={() => void refresh()} extraSection={<SlidesHomeSection />} />
    {fileReference.picker}
    {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} onRestartTutorial={() => { setHelpOpen(false); tutorial.start(); }} />}
    <TutorialOverlay tutorial={tutorial} options={tutorial.overlayOptions} />
  </main>;
}
