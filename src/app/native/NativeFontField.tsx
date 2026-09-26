import {FONTS,resolveFontByValue} from '../../core/fonts';

const GROUP_LABEL={bundled:'同梱フォント',system:'システム'} as const;

/**
 * フォント選択。値は `TextAppearance.fontFamily`（family 文字列）。id は保存しない。
 *
 * `value` は生 family だけでなく、フォールバック込みのスタック（telop の保存値）や
 * 先頭が `"<family>"` の旧スタックでも渡され得る。`resolveFontByValue` でどの表記でも
 * 同じ書体を選択状態にする。onCommit には常に選んだ option の生 family を渡す
 * （スタックへの変換は呼び出し側の責務）。
 *
 * 一覧に無い family（旧案件・手書き設定）は先頭に 1 件だけ残す。選び直す前に消えると
 * 「開いたら勝手にフォントが変わった」になるため、消さずに見せる。
 */
export function NativeFontField({value,disabled,onCommit}:{value:string;disabled:boolean;onCommit(family:string):void}) {
  const resolved=resolveFontByValue(value);
  const known=resolved!==undefined;
  const bundled=resolved?.group==='bundled'?resolved:undefined;
  const selectValue=resolved?.family??value;
  const groups=(['bundled','system'] as const).map(group=>({group,fonts:FONTS.filter(font=>font.group===group)})).filter(item=>item.fonts.length);
  return <label className="native-property native-font-field"><span>フォント</span>
    <select aria-label="フォント" value={selectValue} disabled={disabled} onChange={event=>onCommit(event.target.value)}>
      {!known&&<option value={value}>この案件の設定（一覧にありません）</option>}
      {groups.map(({group,fonts})=><optgroup key={group} label={GROUP_LABEL[group]}>
        {fonts.map(font=><option key={font.id} value={font.family} style={{fontFamily:font.family}}>{font.label}</option>)}
      </optgroup>)}
    </select>
    <span className="native-font-sample" style={{fontFamily:value}} aria-hidden="true">あアAg 123 見本</span>
    {bundled&&<p className="native-subtle">この書体に無い文字は、似た系統のシステムフォントで表示されます。</p>}
  </label>;
}
