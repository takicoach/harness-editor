import {useState} from 'react';
import {loadTrackHeightScales,saveTrackHeightScales,type TrackHeightScales} from './trackHeight';

/** Scope display preferences to the project and document, not reusable track IDs. */
export function useTrackHeights(projectId:string,documentId:string) {
  const [state,setState]=useState(()=>({projectId,documentId,scales:loadTrackHeightScales(projectId,documentId)}));
  let current=state;
  if(state.projectId!==projectId||state.documentId!==documentId){
    current={projectId,documentId,scales:loadTrackHeightScales(projectId,documentId)};
    setState(current);
  }
  return {
    scales:current.scales,
    setScale(trackId:string,scale:number|null){
      const scales:TrackHeightScales={...current.scales};
      if(scale===null)delete scales[trackId];else scales[trackId]=scale;
      saveTrackHeightScales(projectId,documentId,scales);
      setState({projectId,documentId,scales});
    },
  };
}
