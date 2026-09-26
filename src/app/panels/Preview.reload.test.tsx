/** @vitest-environment jsdom */
import { createRef, forwardRef, useEffect, useImperativeHandle } from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Preview, projectPreviewInput } from './Preview';
import { initialEditState } from '../edit/editState';
import type { PlaybackModel } from '../../preview/playbackModel';
import type { EditorProject } from '../../core/types';
import type { EditorPlaybackRef } from '../preview/editorPlayback';

const calls = vi.hoisted(() => ({project:vi.fn(), mount:vi.fn(), overlay:vi.fn(), seek:vi.fn(), status:'ready'}));
vi.mock('../native/useLegacyPreview', () => ({useLegacyPreview: (id: string, project: unknown, reload: string) => {
  calls.project(id,project,reload); return {status:calls.status,document:{revision:1},legacyContext:'lease'};
}}));
vi.mock('../native/EditorLegacyPreview', () => ({EditorLegacyPreview: forwardRef(function Native(_props, ref) {
  useEffect(() => { calls.mount(); }, []);
  useImperativeHandle(ref, () => ({getCurrentFrame:()=>20,seekTo:calls.seek,isPlaying:()=>false,play:()=>{},pause:()=>{},
    addEventListener:()=>{},removeEventListener:()=>{},getGeometry:()=>null,measureLegacy:()=>null}), []);
  return <section className="native-preview"/>;
})}));
vi.mock('../preview/PreviewOverlay', () => ({PreviewOverlay: (props: unknown) => { calls.overlay(props); return <div data-testid="direct-manipulation"/>; }}));
vi.mock('../preview/ShapeToolbar', () => ({ShapeToolbar: () => <div data-testid="shape-toolbar"/>}));
const noop = () => {};
const project = {videoConfig:{fps:30,durationFrames:300,resolution:{width:1080,height:1920},videoFile:'main.mp4'},transcript:{words:[],segments:[]}} as unknown as EditorProject;
const model = {fps:30,width:1080,height:1920,durationInFrames:300,mainSpeed:1,speedSegments:null,playbackOverlaps:[]} as unknown as PlaybackModel;
const props = () => ({model,project,projectId:'p1',hasVideo:true,seLibrary:[],imageLibrary:[],videoLibrary:[],bgmLibrary:[],
  state:initialEditState(project),onLive:noop,onEdit:noop,onDrawingKindChange:noop,onReloadPreview:noop});
afterEach(() => { cleanup(); vi.clearAllMocks(); calls.status = 'ready'; });

describe('native central preview connection', () => {
  it('keeps the gesture owner mounted through preparation/failure, but exposes tools and geometry only when ready', () => {
    calls.status = 'pending';
    const input = props(), view = render(<Preview {...input}/>);
    expect(view.queryByTestId('shape-toolbar')).toBeNull();
    const gestureOwner = view.getByTestId('direct-manipulation');
    expect(calls.overlay.mock.lastCall![0].readNativeMeasurement('telop',1)).toBeNull();
    calls.status = 'failed'; view.rerender(<Preview {...input}/>);
    expect(view.queryByTestId('shape-toolbar')).toBeNull();
    expect(view.getByTestId('direct-manipulation')).toBe(gestureOwner);
    calls.status = 'ready'; view.rerender(<Preview {...input}/>);
    expect(view.queryByTestId('shape-toolbar')).not.toBeNull();
    expect(view.getByTestId('direct-manipulation')).toBe(gestureOwner);
  });
  it('keeps the transport facade and edit controls mounted while resources reload', () => {
    const ref = createRef<EditorPlaybackRef>(), input = props(), onReloadPreview = vi.fn();
    const view = render(<Preview {...input} ref={ref} reloadKey={0} onReloadPreview={onReloadPreview}/>);
    const facade = ref.current;
    const button = view.getByRole('button',{name:'プレビューを再読み込み'});
    expect(button.title).toContain('編集内容は失われません'); fireEvent.click(button); expect(onReloadPreview).toHaveBeenCalledOnce();
    view.rerender(<Preview {...input} ref={ref} reloadKey={1}/>);
    expect(calls.mount).toHaveBeenCalledOnce(); expect(ref.current).toBe(facade);
    expect(calls.project.mock.calls.at(-1)?.[2]).not.toBe(calls.project.mock.calls[0]?.[2]);
    expect(calls.overlay.mock.calls.at(-1)?.[0].readNativeMeasurement).toBeTypeOf('function');
  });
  it('keeps projection identity for selection, tab and frame-neutral renders but includes live edits', () => {
    const input = props(), view = render(<Preview {...input}/>);
    const original = calls.project.mock.calls.at(-1)?.[1];
    view.rerender(<Preview {...input} state={{...input.state,selection:{kind:'telop',id:7}}} showEditOverlay={false}/>);
    expect(calls.project.mock.calls.at(-1)?.[1]).toBe(original);
    const telops = [{id:7,originalStart:0,originalEnd:60,text:'未保存',template:1}];
    view.rerender(<Preview {...input} state={{...input.state,telops}}/>);
    expect(calls.project.mock.calls.at(-1)?.[1]).not.toBe(original);
    expect(calls.project.mock.calls.at(-1)?.[1].telops).toBe(telops);
  });
  it('retains missing items in EditState while omitting their display-only references', () => {
    const input = props(), images = [{id:8,originalStart:0,originalEnd:60,file:'missing.png',type:'plain',scale:1}] as typeof input.state.images;
    const state = {...input.state,images}, view = render(<Preview {...input} state={state}/>);
    const original = calls.project.mock.calls.at(-1)?.[1]; expect(original.images).toEqual([]); expect(state.images).toBe(images);
    view.rerender(<Preview {...input} state={{...state,selection:{kind:'image',id:8}}}/>);
    expect(calls.project.mock.calls.at(-1)?.[1]).toBe(original);
  });
  it('uses identity source-clock playback during cut bypass without changing the session', () => {
    const input = props(), state = {...input.state,cutRegions:[{start:10,end:20}],cutOrder:[{originalStart:20,originalEnd:300},{originalStart:0,originalEnd:10}],mainSpeed:2,segmentSpeeds:{0:2}};
    const projected = projectPreviewInput(project,state,true,input);
    expect(projected.cutRegions).toEqual([]); expect(projected.cutOrder).toEqual([]);
    expect(projected.sceneTransitions).toEqual([]); expect(projected.mainSpeed).toBe(1); expect(projected.segmentSpeeds).toEqual({});
    expect(state.cutRegions).toEqual([{start:10,end:20}]); expect(state.mainSpeed).toBe(2);
  });
});
