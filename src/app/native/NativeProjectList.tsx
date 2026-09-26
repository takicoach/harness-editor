import {useCallback,useEffect,useRef,useState} from 'react';
import {FolderBrowser} from '../panels/FolderBrowser';
import {fetchJson} from '../fetchJson';
import {applyStatusPatch,mergeProjectSummaries,type ProjectListEntry} from '../projectSummaries';
import {useProjectsWatch} from '../useProjectsWatch';
import {TaskProgress} from '../components/TaskProgress';
import type {ProjectSummary} from '../../shared/types';

/** The existing project browser, with the same live status as the home screen. */
export function NativeProjectList({projectId,disabled,onPick}:{projectId:string;disabled:boolean;onPick(id:string):void}) {
  const [projects,setProjects]=useState<ProjectListEntry[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null);
  const generation=useRef(0),request=useRef<AbortController|null>(null);
  const refresh=useCallback(async()=>{
    const version=++generation.current;request.current?.abort();
    const controller=new AbortController();request.current=controller;
    try {
      const result=await fetchJson<{projects:ProjectSummary[]}>('/api/projects',{signal:controller.signal});
      if(!Array.isArray(result.projects))throw new Error('プロジェクト一覧を読み込めませんでした。もう一度読み込んでください。');
      if(!controller.signal.aborted&&version===generation.current){setProjects(previous=>mergeProjectSummaries(previous,result.projects));setError(null);}
    } catch(error) {
      if(!controller.signal.aborted&&version===generation.current)setError(error instanceof Error?error.message:String(error));
    } finally {if(!controller.signal.aborted&&version===generation.current)setLoading(false);}
  },[]);
  useEffect(()=>{void refresh();return()=>{generation.current++;request.current?.abort();};},[refresh]);
  useProjectsWatch(true,(id,patch)=>setProjects(previous=>applyStatusPatch(previous,id,patch)),()=>void refresh());
  return <section className="native-project-list" aria-label="プロジェクト一覧" data-native-script-flush>
    {loading?<TaskProgress label="プロジェクトを読み込み中…" compact/>:<fieldset disabled={disabled}>
      <FolderBrowser open disabled={disabled} projects={projects} activeId={projectId} error={error} onPick={id=>{if(!disabled&&id!==projectId)onPick(id);}}/>
    </fieldset>}
    {error&&<button onClick={()=>void refresh()}>一覧を再読み込み</button>}
  </section>;
}
