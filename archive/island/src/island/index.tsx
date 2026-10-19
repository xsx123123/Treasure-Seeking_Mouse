import { FullPresentation } from './FullPresentation';
import { PresentationContext } from '../presentation-context';
import { clearTreasureBursts } from './memoryTreasureBurst';
import { memoryStorage } from './memoryStorage';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { EmptyState } from '../components/chat/EmptyState';
import mouseBase from '../assets/pet/mouse-base.webp';
import mouseShovel from '../assets/pet/mouse-shovel.webp';
import mouseNight from '../assets/pet/mouse-night.webp';
import { Composer } from '../components/chat/Composer';
import { ControlledI18nProvider } from '../i18n/provider';
import originalStyles from '../styles.css?inline';
import type { TreasureIslandHandle, TreasureIslandProps } from './contract';
export type { TreasureIslandHandle, TreasureIslandProps } from './contract';
export { paperEvidenceToWorkspace } from './paperEvidence';
export { classifyPaperInput } from './paperInput';

const owners = new WeakSet<HTMLElement>();
const noTyping = () => {};
let fontUsers = 0;
let fontStyle: HTMLStyleElement | undefined;
// Font faces are document resources in Chromium; only these rules leave the shadow tree.
const fontRules = originalStyles.match(/@font-face\s*\{[^}]+\}/g)?.join('\n') || '';
const shadowStyles = originalStyles.replace(/@font-face\s*\{[^}]+\}/g, '')
  .replace(/:root\b/g, '.treasure-island-root');
function View({ props, portal }: { props: TreasureIslandProps; portal: HTMLElement }) {
  if (props.mode === 'pet') return <img src={props.streaming ? (props.context.theme === 'dark' ? mouseNight : mouseShovel) : mouseBase} alt={props.context.locale === 'zh' ? '阿寻' : 'Axun'} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />;
  const composer = <Composer models={[...props.modelOptions]}
        model={props.selectedModel} onModelChange={props.onSelectModel}
        streaming={props.streaming} disabled={props.disabled} onSend={props.onSubmit}
        onStop={props.onCancel} value={props.draft} onValueChange={props.onDraftChange}
        welcome={props.mode !== 'composer'} onTyping={noTyping} paperMode={props.paperMode}
        onPaperInput={file => props.onPaperAction?.({ type: 'paper.input', input: { kind: 'pdf', file } })} />;
  return <ControlledI18nProvider lang={props.context.locale} onChange={props.onLocaleChange}>
    {props.mode === 'app' ? <FullPresentation props={props} /> : props.mode === 'composer' ? composer : <EmptyState onPick={props.onPickExample}
      submitting={props.streaming || props.disabled} dialogContainer={portal} composer={composer} />}
  </ControlledI18nProvider>;
}
/** Presentation-only platform mount: Vue supplies all business data and commands. */
export function mount(container: HTMLElement, initial: TreasureIslandProps): TreasureIslandHandle {

  if (initial.messages.length && initial.mode !== 'app') throw new Error('Messages require app presentation mode');
  if (owners.has(container)) throw new Error('Treasure island already mounted');
  if (container.shadowRoot?.childNodes.length) throw new Error('Treasure island host is not empty');
  const shadow = container.shadowRoot || container.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = shadowStyles + `\n:host{display:block;min-width:0} .treasure-island-root{min-height:100%;background:var(--background);color:var(--foreground);font-family:var(--font-sans);isolation:isolate} .treasure-island-view{min-height:inherit} .treasure-island-root[data-mode=pet]{background:transparent} :host([data-mode=app]){height:100%} .treasure-island-root[data-mode=app]{height:100%;min-height:0} .treasure-island-root[data-mode=app] .treasure-island-view{height:100%;min-height:0;transform:translateZ(0)} .treasure-top-action{display:flex;align-items:center;justify-content:center;padding:6px;border-radius:6px;color:var(--muted-foreground);cursor:pointer} .treasure-top-action:hover{background:var(--secondary);color:var(--helix)}`;
  const theme = document.createElement('div');
  const view = document.createElement('div');
  view.className = 'treasure-island-view';
  const portal = document.createElement('div');
  portal.dataset.treasurePortal = '';
  theme.append(view, portal);
  shadow.append(style, theme);
  owners.add(container);
  if (fontUsers++ === 0) {
    fontStyle = document.createElement('style');
    fontStyle.dataset.treasureIslandFonts = '';
    fontStyle.textContent = fontRules;
    document.head.append(fontStyle);
  }
  const root = createRoot(view);
  let disposed = false;
  function update(props: TreasureIslandProps) {
    if (disposed) throw new Error('Treasure island has been unmounted');
    if (props.messages.length && props.mode !== 'app') throw new Error('Messages require app presentation mode');

    theme.className = `treasure-island-root${props.context.theme === 'dark' ? ' dark' : ''}`;
    container.dataset.mode = props.mode || "welcome";
    theme.dataset.mode = props.mode || 'welcome';
    theme.lang = props.context.locale === 'zh' ? 'zh-CN' : 'en';
    flushSync(() => root.render(<PresentationContext.Provider value={{ portalContainer: portal, onResearchAction: props.onResearchAction, workflow: props.workflow, loadLiterature: props.loadLiterature, theme: props.context.theme, viewport: () => container.getBoundingClientRect() }}><View props={props} portal={portal} /></PresentationContext.Provider>));
  }
  update(initial);
  return { update, unmount() {
    if (disposed) return;
    disposed = true;
    flushSync(() => root.unmount());
    shadow.replaceChildren();
    owners.delete(container);
    if (--fontUsers === 0) { fontStyle?.remove(); fontStyle = undefined; memoryStorage.clear(); clearTreasureBursts(); }
  } };
}
