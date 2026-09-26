import { describe, expect, it } from 'vitest';
import { injectTransitionRootSource } from './transitionWiring';

describe('injectTransitionRootSource', () => {
  it('MainVideoだけを書き換え、別Compositionが使う旧尺importを残す', () => {
    const source = `import { Composition } from 'remotion';
import { MainVideo } from './MainVideo';
import { Other } from './Other';
import { CUT_DURATION_FRAMES } from './cutData';
export const Root=()=> <><Composition id="main" component={MainVideo} durationInFrames={CUT_DURATION_FRAMES}/><Composition id="other" component={Other} durationInFrames={CUT_DURATION_FRAMES}/></>;
`;
    const out = injectTransitionRootSource(source, './cutData', false);
    expect(out).not.toBeNull();
    expect(out).toContain('component={MainVideo} durationInFrames={transitionCompositionDuration(cutData, transitionData, 1)}');
    expect(out).toContain('component={Other} durationInFrames={CUT_DURATION_FRAMES}');
    expect(out).toContain('CUT_DURATION_FRAMES');
  });

  it('MainVideo Compositionが無ければ別Compositionを書き換えない', () => {
    const source = `import { Composition } from 'remotion';
import { Other } from './Other';
export const Root=()=> <Composition component={Other} durationInFrames={100}/>;
`;
    expect(injectTransitionRootSource(source, './cutData', false)).toBeNull();
  });

  it('type-only bindingをruntime値として再利用せずvalue importへ昇格する', () => {
    const source = `import { Composition } from 'remotion';
import { MainVideo } from './MainVideo';
import type { transitionData } from './Transition';
export const Root=()=> <Composition component={MainVideo} durationInFrames={100}/>;
`;
    const out = injectTransitionRootSource(source, './cutData', false);
    expect(out).not.toBeNull();
    expect(out).not.toContain('import type { transitionData }');
    expect(out).toMatch(/import \{[^}]*\btransitionData\b[^}]*\} from '\.\/Transition';/);
    expect((out?.match(/\btransitionData\b/g) ?? [])).toHaveLength(2); // value import + duration call
  });

  it('別exportのaliasが必要local名を占有していればfail-closed', () => {
    const source = `import { Composition } from 'remotion';
import { MainVideo } from './MainVideo';
import { Other as transitionData } from './Transition';
export const Root=()=> <Composition component={MainVideo} durationInFrames={100}/>;
`;
    expect(injectTransitionRootSource(source, './cutData', false)).toBeNull();
  });

  it('top-level value bindingが必要import名を占有していればfail-closed', () => {
    const source = `import { Composition } from 'remotion';
import { MainVideo } from './MainVideo';
const transitionData = [];
export const Root=()=> <Composition component={MainVideo} durationInFrames={100}/>;
`;
    expect(injectTransitionRootSource(source, './cutData', false)).toBeNull();
  });
});
