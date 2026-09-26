import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import ts from 'typescript';
import { isValidTsx } from './transitionWiring';
import { readNativeDataPackState, type NativeDataPackId } from './nativeDataPacks';
import { parseVideoConfigStatic } from '../core/videoConfig';
import { LEGACY_MAIN_AUDIO_PAYLOADS } from './legacyMainAudioPayloads';

export const MAIN_AUDIO_UNSUPPORTED = 'この案件の動画構成では元音声の調整を保存できません。動画構成の確認が必要です。設定は変更せず保持しています。';

const read = (dir: string, path: string) => readFileSync(join(dir, path), 'utf8');
type Element = ts.JsxSelfClosingElement | ts.JsxOpeningElement;
function elements(source: string) {
  const file = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const items: Element[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) items.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { file, items };
}
function props(node: Element, file: ts.SourceFile): Map<string, string> | null {
  const result = new Map<string, string>();
  for (const attr of node.attributes.properties) {
    if (!ts.isJsxAttribute(attr)) return null;
    const key = attr.name.getText(file);
    if (result.has(key)) return null;
    const value = attr.initializer;
    result.set(key, value && ts.isJsxExpression(value)
      ? value.expression?.getText(file).replace(/\s+/g, '') ?? ''
      : value && ts.isStringLiteral(value) ? value.text : '');
  }
  return result;
}
function imported(file: ts.SourceFile, name: string, from: string): boolean {
  return file.statements.some(s => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier)
    && s.moduleSpecifier.text === from && s.importClause?.namedBindings
    && ts.isNamedImports(s.importClause.namedBindings)
    && s.importClause.namedBindings.elements.some(e => e.name.text === name && (!e.propertyName || e.propertyName.text === name)));
}
function canonicalPack(dir: string, installed: keyof typeof LEGACY_MAIN_AUDIO_PAYLOADS): boolean {
  // Recognize the frozen standard sources, including historical transitionData.
  // As before, unrelated extra installed files do not affect recognition.
  return Object.entries(LEGACY_MAIN_AUDIO_PAYLOADS[installed]).every(([path, expected]) => {
    const bytes = readFileSync(join(dir, 'src', installed, path));
    return createHash('sha256').update(bytes).digest('hex') === expected;
  });
}

/** Read-only capability check. A marker alone cannot establish render parity:
 * standard JSX wiring and any already-installed time-mapping payload must match.
 * New standard projects need no installation in the original directory. */
export function detectMainAudioSupport(dir: string): boolean {
  try {
    // A data-only project has explicitly installed native packs and no legacy
    // composition to reinterpret. Existing custom JSX still follows the strict
    // source checks below; a marker cannot certify arbitrary old source behavior.
    if (!existsSync(join(dir, 'src/MainVideo.tsx')) && !existsSync(join(dir, 'src/Root.tsx'))) {
      const packs: NativeDataPackId[] = ['bgm','videoInsert','speed','transition','mainLayout','shape'];
      if (!packs.some(id => readNativeDataPackState(id,dir).status === 'ready')) return false;
      const config = parseVideoConfigStatic(read(dir, 'src/videoConfig.ts'));
      return [config.fps,config.durationFrames,config.resolution.width,config.resolution.height]
        .every(value=>Number.isFinite(value)&&value>0);
    }
    const mainSource = read(dir, 'src/MainVideo.tsx'), rootSource = read(dir, 'src/Root.tsx');
    if (!isValidTsx(mainSource) || !isValidTsx(rootSource)) return false;
    const main = elements(mainSource);
    // Independent JSX audio has no binding in the structured native timeline.
    // Preserving its source does not prove that a native export will play it.
    const runtimeAudioNames = new Set(['Audio', 'Html5Audio']);
    const audioTags = new Set([...runtimeAudioNames, 'audio']);
    for (const statement of main.file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || statement.moduleSpecifier.text !== 'remotion') continue;
      const bindings = statement.importClause?.namedBindings;
      const defaultName = statement.importClause?.name?.text;
      if (defaultName) for (const name of runtimeAudioNames) audioTags.add(`${defaultName}.${name}`);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) {
          if (runtimeAudioNames.has((item.propertyName ?? item.name).text)) audioTags.add(item.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        for (const name of runtimeAudioNames) audioTags.add(`${bindings.name.text}.${name}`);
      }
    }
    if (main.items.some(node => audioTags.has(node.tagName.getText(main.file)))) return false;
    const root = elements(rootSource);
    const compositions = root.items.filter(n => n.tagName.getText(root.file) === 'Composition');
    if (compositions.length === 0 || compositions.filter(n => props(n, root.file)?.get('id') === 'MainVideo').length !== 1 || !imported(root.file, 'Composition', 'remotion')
      || !imported(root.file, 'MainVideo', './MainVideo')) return false;
    const composition = props(compositions[0]!, root.file);
    if (!composition || composition.get('id') !== 'MainVideo' || composition.get('component') !== 'MainVideo'
      || !composition.has('durationInFrames') || composition.has('calculateMetadata')) return false;
    if (!imported(main.file, 'staticFile', 'remotion') || !imported(main.file, 'VIDEO_FILE', './videoConfig')) return false;
    const candidates = main.items.filter(n => {
      const name = n.tagName.getText(main.file), p = props(n, main.file);
      return ['SpeedPlayer', 'CutPlayerWithTransitions', 'CutPlayer'].includes(name)
        || (['OffthreadVideo', 'Video'].includes(name) && p?.get('src') === 'staticFile(VIDEO_FILE)');
    });
    if (candidates.length !== 1) return false;
    const node = candidates[0]!, name = node.tagName.getText(main.file), p = props(node, main.file);
    if (!p) return false;
    // A nested Sequence/Loop or conditional source would require a different
    // timeline than the full-composition stem. Do not silently erase that timing.
    let inMain = false;
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (ts.isConditionalExpression(parent) || ts.isCallExpression(parent)) return false;
      if (ts.isJsxElement(parent) && ['Sequence', 'Series.Sequence', 'Loop', 'Freeze'].includes(parent.openingElement.tagName.getText(main.file))) return false;
      if ((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent)) && parent.name?.getText(main.file) === 'MainVideo') inMain = true;
    }
    if (!inMain) return false;
    if (['OffthreadVideo', 'Video'].includes(name)) {
      if (!ts.isJsxSelfClosingElement(node) || !imported(main.file, name, 'remotion')
        || (existsSync(join(dir, 'src/Speed/speed.json')) && readNativeDataPackState('speed',dir).status !== 'ready')) return false;
      if ([...p.keys()].some(key => !['src', 'volume', 'style'].includes(key))) return false;
      if (p.has('volume') && Number(p.get('volume')) !== 1) return false;
      if (p.has('style')) {
        const style = p.get('style')!.replace(/"/g, "'").replace(/,}/g, '}');
        if (style !== "{width:'100%',height:'100%',objectFit:'contain'}") return false;
      }
      return true;
    }
    if (p.get('videoSrc') !== 'staticFile(VIDEO_FILE)' || p.get('cutData') !== 'cutData'
      || p.get('mainSpeed') !== 'MAIN_SPEED') return false;
    if (name === 'SpeedPlayer') {
      return imported(main.file, name, './Speed') && p.get('segmentSpeeds') === 'SEGMENT_SPEEDS'
        && composition.get('durationInFrames') === 'speedCompositionDuration(cutData,CUT_DURATION_FRAMES,MAIN_SPEED,SEGMENT_SPEEDS)'
        && imported(root.file, 'speedCompositionDuration', './Speed')
        && [...p.keys()].every(key => ['cutData', 'videoSrc', 'mainSpeed', 'segmentSpeeds'].includes(key))
        && canonicalPack(dir, 'Speed');
    }
    if (name === 'CutPlayerWithTransitions') {
      return imported(main.file, name, './Transition') && p.get('transitions') === 'transitionData'
        && composition.get('durationInFrames') === 'transitionCompositionDuration(cutData,transitionData,MAIN_SPEED)'
        && imported(root.file, 'transitionCompositionDuration', './Transition')
        && [...p.keys()].every(key => ['cutData', 'videoSrc', 'mainSpeed', 'transitions'].includes(key))
        && canonicalPack(dir, 'Transition');
    }
    return false;
  } catch { return false; }
}
