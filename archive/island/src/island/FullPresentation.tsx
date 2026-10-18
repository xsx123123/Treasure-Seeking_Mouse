import { useEffect, useRef, useState } from 'react';
import { BarChart3, ChevronsLeft, ChevronsRight, Info, Loader2, Menu, Moon, PawPrint, RefreshCw, Sun, Trophy, X } from 'lucide-react';
import { BrandMark } from '../components/BrandMark';
import { LanguageToggle } from '../components/LanguageToggle';
import { EmptyState } from '../components/chat/EmptyState';
import { Composer } from '../components/chat/Composer';
import { ChatMessage } from '../components/chat/ChatMessage';
import { SessionSidebar, MobileDrawerHeader } from '../components/chat/SessionSidebar';
import { Leaderboard } from '../components/chat/Leaderboard';
import { UsageStatsDialog } from '../components/chat/UsageStatsDialog';
import { TreasureMouse, makePetEvent, type PetEvent } from '../components/pet/TreasureMouse';
import { PetSettingsPanel } from '../components/pet/PetSettingsPanel';
import { emitPetTyping } from '../lib/petBus';
import { onHintDismissed, onHintShown } from '../lib/hintBus';
import { useI18n } from '../i18n/provider';
import { ResearchWorkflowPanel } from './ResearchWorkflowPanel';
import { PaperWorkspace } from './PaperWorkspace';
import { AboutPresentation } from './AboutPresentation';
import type { TreasureIslandProps } from './contract';

/** The original presentation tree; every business action goes back to the Vue owner. */
export function FullPresentation({ props }: { props: TreasureIslandProps }): React.ReactElement {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [board, setBoard] = useState(false);
  const [stats, setStats] = useState(false);
  const [about, setAbout] = useState(false);
  const [petPanel, setPetPanel] = useState(false);
  const [petEvent, setPetEvent] = useState<PetEvent | null>(null);
  const scrolling = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previous = useRef({ streaming: false, tools: 0, cards: 0, id: '' });
  const last = props.messages.at(-1);
  const cards = last?.cards ?? [];
  const tools = last?.liveTools ?? [];
  useEffect(() => {
    const current = { streaming: props.streaming, tools: tools.length, cards: cards.length, id: last?.id ?? '' };
    const old = previous.current;
    if (last?.streaming && (tools.length !== old.tools || current.id !== old.id)) {
      setPetEvent(makePetEvent({ type: tools.at(-1)?.name === 'literature_search' ? 'lit_start' : 'tool_start' }));
    } else if (last?.streaming && cards.length > old.cards) {
      setPetEvent(makePetEvent({ type: cards.some(card => card.meta.source === 'literature') ? 'lit_cards' : 'cards', count: cards.length - old.cards }));
    } else if (old.streaming && !props.streaming) {
      setPetEvent(makePetEvent(last?.error ? { type: 'error' } : { type: 'done', cards: cards.length }));
    }
    previous.current = current;
  }, [props.streaming, tools, cards, last]);
  useEffect(() => {
    const off = onHintShown(() => setPetEvent(makePetEvent({ type: 'hint' })));
    const offEnd = onHintDismissed(() => setPetEvent(makePetEvent({ type: 'hint_end' })));
    return () => { off(); offEnd(); };
  }, []);
  useEffect(() => {
    if (follow.current && scrolling.current) scrolling.current.scrollTop = scrolling.current.scrollHeight;
  }, [props.messages]);
  const sidebar = <SessionSidebar platform sessions={props.sessions ?? []}
    activeId={props.activeSessionId ?? null} userLabel={null}
    onSelect={id => { follow.current = true; props.onSelectSession?.(id); setDrawer(false); }}
    onNew={() => { follow.current = true; props.onNewSession?.(); setDrawer(false); }}
    onRename={(id, title) => props.onRenameSession?.(id, title)}
    onDelete={id => props.onArchiveSession?.(id)} onLogout={() => {}} />;
  const composer = <Composer models={[...props.modelOptions]} model={props.selectedModel}
    onModelChange={props.onSelectModel} streaming={props.streaming} disabled={props.disabled}
    onSend={text => { follow.current = true; props.onSubmit(text); }} onStop={props.onCancel}
    value={props.draft} onValueChange={props.onDraftChange} welcome={!props.messages.length} onTyping={emitPetTyping}
    paperMode={props.paperMode} onPaperInput={file => props.onPaperAction?.({ type: 'paper.input', input: { kind: 'pdf', file } })} />;
  const notice = props.accessError || props.historyError;
  return <div className="treasure-app bg-grid touch-clean flex h-full min-h-0 overflow-hidden" data-treasure-app="">
    {collapsed ? <aside className="hidden w-12 shrink-0 flex-col items-center gap-4 border-r border-border bg-panel py-3 md:flex">
      <button className="rounded-md p-1.5 text-rail-icon hover:bg-secondary" aria-label={t('header.expandSessions')} onClick={() => setCollapsed(false)}><ChevronsRight size={17} /></button>
      <button className="rounded-xl border border-helix/20 bg-helix-soft p-2 text-helix" aria-label={t('sidebar.newChat')} disabled={props.disabled} onClick={props.onNewSession}><BrandMark /></button>
    </aside> : <div className="relative hidden w-[260px] shrink-0 md:block">
      {sidebar}<button className="absolute -right-3 top-5 z-10 rounded-full border border-border bg-card p-1 text-muted-foreground shadow-soft" aria-label={t('header.collapseSessions')} onClick={() => setCollapsed(true)}><ChevronsLeft size={13} /></button>
    </div>}
    {drawer ? <div className="fixed inset-0 z-40 md:hidden"><div className="absolute inset-0 bg-black/30" onClick={() => setDrawer(false)} /><div className="absolute inset-y-0 left-0 w-[280px] max-w-[85%] bg-panel"><MobileDrawerHeader onClose={() => setDrawer(false)} /><div className="h-[calc(100%-49px)]">{sidebar}</div></div></div> : null}
    <main className="relative flex min-w-0 flex-1 flex-col">
      <header className="safe-t flex items-center gap-1 border-b border-border bg-panel/70 px-2 py-2.5 sm:gap-2 sm:px-4 md:px-6">
        <button className="rounded-md p-1.5 text-muted-foreground md:hidden" aria-label={t('header.openSessions')} onClick={() => setDrawer(true)}><Menu size={18} /></button>
        <h1 className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{props.sessions?.find(s => s.id === props.activeSessionId)?.title || t('brand.name')}</h1>
        <select aria-label={props.context.locale === 'zh' ? '项目上下文' : 'Project context'} value={props.context.projectId ?? ''} onChange={event => props.onChangeProject?.(event.target.value)} className="max-w-[110px] truncate rounded-md bg-transparent px-1 py-1 text-[11px] text-muted-foreground sm:max-w-[180px]" disabled={props.loading}>
          <option value="">{props.context.locale === 'zh' ? '全局只读' : 'Global read-only'}</option>
          {props.projects?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <button className="treasure-top-action" aria-label={props.context.locale === 'zh' ? '刷新权限' : 'Refresh access'} onClick={props.onRefresh} disabled={props.loading}><RefreshCw size={16} /></button>
        <button className="treasure-top-action" title={t('header.leaderboard')} aria-label={t('header.leaderboardAria')} onClick={() => setBoard(true)}><Trophy size={17} /></button>
        <button className="treasure-top-action" title={t('header.stats')} aria-label={t('header.statsAria')} onClick={() => setStats(true)}><BarChart3 size={17} /></button>
        <button className="treasure-top-action" title={t('header.about')} aria-label={t('header.aboutAria')} onClick={() => setAbout(true)}><Info size={17} /></button>
        <button className="treasure-top-action text-[11px]" disabled={props.disabled || !props.workflow?.allowedTools?.includes('dataset.list_project_assets') || !props.context.projectId} onClick={() => props.onResearchAction?.({ type: 'dataset.list' })}>{t('workflow.assets')}</button>
        {props.paperWorkspace && props.onPaperAction ? <button className="treasure-top-action text-[11px]" disabled={props.disabled} onClick={() => props.onPaperAction?.({ type: 'paper.tab', tab: 'interpretation' })}>{t('paper.title')}</button> : null}
        {props.onResearchAction ? <button className="treasure-top-action text-[11px]" disabled={props.disabled} onClick={() => props.onResearchAction?.({ type: 'capabilities.refresh' })}>{t('workflow.capabilities')}</button> : null}
        <LanguageToggle />
        <button className="treasure-top-action" title={t('pet.settings.gear')} aria-label={t('pet.settings.gear')} onClick={() => setPetPanel(value => !value)}><PawPrint size={17} /></button>
        <button className="treasure-top-action" title={props.context.theme === 'dark' ? t('header.themeDark') : t('header.themeLight')} aria-label={t('header.themeAria')} onClick={props.onThemeChange}>{props.context.theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>
      </header>
      {notice ? <p role="status" className="border-b border-border bg-panel px-4 py-2 text-[12px] text-muted-foreground">{notice}</p> : null}
      <div ref={scrolling} className="min-h-0 flex-1 overflow-y-auto" onScroll={() => { const el = scrolling.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
        {props.loading ? <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin text-helix" /></div> : !props.messages.length ? <EmptyState composer={composer} submitting={props.disabled || props.streaming} onPick={props.onPickExample} /> : <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6" data-treasure-messages="">
          {props.messages.map((message, index) => <ChatMessage key={message.id} msg={message}
            onRegenerate={props.disabled ? undefined : props.onRegenerate}
            onPickSuggestion={props.disabled ? undefined : props.onSubmit}
            linkHint={message.role === 'assistant' && index === props.messages.length - 1} />)}
        </div>}
      </div>
      {props.streamError ? <p role="alert" className="px-4 py-2 text-[12px] text-destructive">{props.streamError}</p> : null}
      {props.messages.length ? composer : null}
    </main>
    {props.workflow && props.onResearchAction ? <ResearchWorkflowPanel key={`${props.workflow.accession ?? ""}:${props.workflow.versionId ?? ""}`} view={props.workflow} action={props.onResearchAction} /> : null}
    {props.paperWorkspace?.open && props.onPaperAction ? <PaperWorkspace view={props.paperWorkspace} action={props.onPaperAction} /> : null}
    <TreasureMouse event={petEvent} welcome={!props.messages.length} />
    {petPanel ? <><div className="fixed inset-0 z-[60]" onClick={() => setPetPanel(false)} /><div className="fixed right-3 top-14 z-[60]"><PetSettingsPanel onClose={() => setPetPanel(false)} /></div></> : null}
    <Leaderboard open={board} onClose={() => setBoard(false)} />
    <UsageStatsDialog open={stats} onClose={() => setStats(false)} />
    {about ? <div role="dialog" aria-modal="true" aria-label={t('header.about')} className="fixed inset-0 z-50 overflow-auto bg-background" onKeyDown={event => { if (event.key === 'Escape') setAbout(false); }}><button className="absolute right-3 top-3 rounded p-2 text-muted-foreground" aria-label={t('lit.close')} onClick={() => setAbout(false)}><X size={18} /></button><AboutPresentation onBack={() => setAbout(false)} theme={props.context.theme} onThemeChange={() => props.onThemeChange?.()} /></div> : null}
  </div>;
}
