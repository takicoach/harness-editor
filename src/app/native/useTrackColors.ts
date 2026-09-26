import {useState} from 'react';
import {loadTrackColors,saveTrackColors,type TrackColorOverrides} from './trackColor';
import type {TrackAccent} from './trackAccent';

/** useTrackHeights と同じ: 案件と文書に紐づく表示の好み。 */
export function useTrackColors(projectId:string,documentId:string) {
  const [state,setState]=useState(()=>({projectId,documentId,colors:loadTrackColors(projectId,documentId)}));
  let current=state;
  if(state.projectId!==projectId||state.documentId!==documentId){
    current={projectId,documentId,colors:loadTrackColors(projectId,documentId)};
    setState(current);
  }
  return {
    colors:current.colors,
    setColor(trackId:string,token:TrackAccent|null){
      const colors:TrackColorOverrides={...current.colors};
      if(token===null)delete colors[trackId];else colors[trackId]=token;
      saveTrackColors(projectId,documentId,colors);
      setState({projectId,documentId,colors});
    },
  };
}
