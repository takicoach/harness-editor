import {expect,it} from 'vitest';
import {ScenePlan,scenePlanFor} from './scenePlan';
import {fixture} from './fixtures';
it('one plan per document object; a temporary document with the same id and revision gets its own (設計 §2-5)',()=>{
  const document=fixture(),plan=scenePlanFor(document);
  expect(scenePlanFor(document)).toBe(plan);expect(plan).toBeInstanceOf(ScenePlan);expect(Object.isFrozen(plan.document)).toBe(true);
  const temporary={...document,clips:document.clips.map(c=>c.id==='video'?{...c,name:'試し'}:c)};
  expect([temporary.id,temporary.revision]).toEqual([document.id,document.revision]);
  const other=scenePlanFor(temporary);expect(other).not.toBe(plan);expect(other.document.clips.find(c=>c.id==='video')!.name).toBe('試し');
});
