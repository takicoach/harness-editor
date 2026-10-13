/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render} from '@testing-library/react';
import type {ProjectSummary} from '../../shared/types';
import {FolderBrowser} from './FolderBrowser';

afterEach(cleanup);
const project:ProjectSummary={id:'p 1',name:'案件',orientation:'h',durationLabel:'0:10',sizeLabel:'1 MB',videoFile:null,videoAssetId:'video-1',status:'telop' as ProjectSummary['status']};
const withCover={...project,thumbnailCover:{file:'サムネ/サムネ_案件.png',mtimeMs:42}};
const props={activeId:null,error:null,onPick:vi.fn(),onToggle:vi.fn()};

it('左の一覧のカードは、サムネの書き出しがあればその画像を出す',()=>{
  const view=render(<FolderBrowser {...props} open projects={[withCover]}/>);
  const thumb=view.container.querySelector('.fb-item .fb-thumb')!;
  expect(thumb.querySelector('img')!.getAttribute('src')).toBe('/api/thumbnail/cover?id=p+1&v=42');
  expect(thumb.querySelector('video')).toBeNull();
});
it('畳んだ一覧でも同じ画像を出す',()=>{
  const view=render(<FolderBrowser {...props} open={false} projects={[withCover]}/>);
  expect(view.container.querySelector('.fb-mini-item .fb-thumb img')!.getAttribute('src')).toBe('/api/thumbnail/cover?id=p+1&v=42');
});
it('サムネの書き出しが無ければ従来どおり動画のコマ',()=>{
  const view=render(<FolderBrowser {...props} open projects={[project]}/>);
  const thumb=view.container.querySelector('.fb-item .fb-thumb')!;
  expect(thumb.querySelector('video')!.getAttribute('src')).toBe('/api/sequence/asset?id=p+1&asset=video-1');
  expect(thumb.querySelector('img')).toBeNull();
});
it('画像を読み込めなければ従来の動画のコマに戻す（畳んだ一覧も同じ）',()=>{
  for(const open of [true,false]){
    const view=render(<FolderBrowser {...props} open={open} projects={[withCover]}/>);
    const thumb=view.container.querySelector('.fb-thumb')!;
    fireEvent.error(thumb.querySelector('img')!);
    expect(thumb.querySelector('img')).toBeNull();
    expect(thumb.querySelector('video')!.getAttribute('src')).toBe('/api/sequence/asset?id=p+1&asset=video-1');
    cleanup();
  }
});
