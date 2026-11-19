/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeNotifications } from './NativeNotifications';
import { emptyNotificationHistory, type EditorNotification } from './notificationHistory';

afterEach(cleanup);
it('offers a report for the selected error and keeps ordinary notices as read-only',()=>{
  const onReport=vi.fn();
  const error:EditorNotification={id:'e',severity:'error',source:'書き出し',message:'Private に失敗 /Users/private/clip.mov',firstAt:1,lastAt:1,count:1};
  const view=render(<NativeNotifications projectId="fixture" storageError="" onClose={()=>{}} onClear={()=>{}} onReport={onReport}
    history={{...emptyNotificationHistory(),records:[error,{...error,id:'info',severity:'info',message:'処理が終わりました'}]}}/>);
  const buttons=view.getAllByRole('button',{name:'報告する'});
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]!);
  expect(onReport).toHaveBeenCalledWith(error);
});
