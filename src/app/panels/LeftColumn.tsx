import type React from 'react';
import { FolderBrowser } from './FolderBrowser';
import { MaterialLibrary } from './MaterialLibrary';
import type { MaterialKind } from './materialList';
import type { ProjectSummary } from '../../shared/types';

export type LeftTab = 'projects' | 'materials';

interface LeftColumnProps {
  tab: LeftTab;
  onPickTab: (tab: LeftTab) => void;
  // FolderBrowser
  folderOpen: boolean;
  projects: ProjectSummary[];
  activeId: string | null;
  projectsError: string | null;
  onPickProject: (id: string) => void;
  onToggleFolder: () => void;
  onGoHome?: () => void;
  // MaterialLibrary
  materialKind: MaterialKind;
  onPickMaterialKind: (kind: MaterialKind) => void;
  seLibrary: string[];
  imageLibrary: string[];
  bgmLibrary: string[];
  videoLibrary: string[];
  projectId: string;
  /** ライブラリ各ファイルの size-mtime トークン。asset URL の &v=（同名差し替えバスト）用。 */
  assetVersions?: Record<string, string>;
  playingPath: string | null;
  onAudition: (url: string, volume?: number) => void;
  onAuditionStop?: () => void;
  onInsert: (kind: MaterialKind, file: string) => void;
  onDragStart?: (kind: MaterialKind, file: string, e: React.PointerEvent) => void;
  onDropFiles?: (files: File[]) => void;
  uploadStatus?: string | null;
}

export function LeftColumn(props: LeftColumnProps) {
  // 畳んだ状態では従来どおりプロジェクトのミニ表示のみ（タブは出さない）。
  if (!props.folderOpen) {
    return (
      <div className="lc">
        <FolderBrowser
          open={false}
          projects={props.projects}
          activeId={props.activeId}
          error={props.projectsError}
          onPick={props.onPickProject}
          onToggle={props.onToggleFolder}
        />
      </div>
    );
  }

  return (
    <div className="lc">
      <div className="lc-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={'lc-tab' + (props.tab === 'projects' ? ' active' : '')}
          data-tab="projects"
          onClick={() => props.onPickTab('projects')}
        >
          プロジェクト
        </button>
        <button
          type="button"
          role="tab"
          className={'lc-tab' + (props.tab === 'materials' ? ' active' : '')}
          data-tab="materials"
          onClick={() => props.onPickTab('materials')}
        >
          素材
        </button>
      </div>
      {props.tab === 'projects' ? (
        <FolderBrowser
          open
          projects={props.projects}
          activeId={props.activeId}
          error={props.projectsError}
          onPick={props.onPickProject}
          onToggle={props.onToggleFolder}
          onGoHome={props.onGoHome}
        />
      ) : (
        <MaterialLibrary
          kind={props.materialKind}
          onPickKind={props.onPickMaterialKind}
          seLibrary={props.seLibrary}
          imageLibrary={props.imageLibrary}
          bgmLibrary={props.bgmLibrary}
          videoLibrary={props.videoLibrary}
          projectId={props.projectId}
          assetVersions={props.assetVersions}
          playingPath={props.playingPath}
          onAudition={props.onAudition}
          onAuditionStop={props.onAuditionStop}
          onInsert={props.onInsert}
          onDragStart={props.onDragStart}
          onDropFiles={props.onDropFiles}
          uploadStatus={props.uploadStatus}
        />
      )}
    </div>
  );
}
