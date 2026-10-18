import { AlertTriangle, ArrowLeft, BookOpen, CheckCircle2, CircleDashed, Database, FileSearch, GitBranch, Loader2 } from 'lucide-react';
import { useI18n } from '../i18n/provider';
import type { MessageKey } from '../i18n';
import type { PaperActionV1, PaperTab, PaperWorkspaceView } from './contract';

const tabs: readonly { id: PaperTab; icon: typeof BookOpen; key: string }[] = [
  { id: 'interpretation', icon: BookOpen, key: 'paper.tab.interpretation' },
  { id: 'provenance', icon: Database, key: 'paper.tab.provenance' },
  { id: 'plan', icon: FileSearch, key: 'paper.tab.plan' },
  { id: 'workflow', icon: GitBranch, key: 'paper.tab.workflow' },
];

function Status({ status }: { status: PaperWorkspaceView['status'] }): React.ReactElement {
  const { t } = useI18n();
  if (status === 'running' || status === 'queued') return <span className="inline-flex items-center gap-1 text-[11px] text-helix"><Loader2 size={12} className="animate-spin" />{t(`paper.status.${status}` as MessageKey)}</span>;
  if (status === 'failed') return <span className="inline-flex items-center gap-1 text-[11px] text-destructive"><AlertTriangle size={12} />{t('paper.status.failed')}</span>;
  return <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><CheckCircle2 size={12} className="text-helix" />{t(`paper.status.${status}` as MessageKey)}</span>;
}

export function PaperWorkspace({ view, action }: { view: PaperWorkspaceView; action: (value: PaperActionV1) => void }): React.ReactElement {
  const { t } = useI18n();
  const active = view.activeTab ?? 'interpretation';
  const evidenceById = new Map(view.evidence.map(item => [item.id, item]));
  return <div role="dialog" aria-modal="true" aria-label={t('paper.title')} className="fixed inset-0 z-50 overflow-y-auto bg-background">
    <div className="mx-auto min-h-full w-full max-w-5xl px-4 py-5 sm:px-8 sm:py-8">
      <header className="flex items-start gap-3 border-b border-border pb-4">
        <button type="button" onClick={() => action({ type: 'paper.close' })} className="rounded-md p-2 text-muted-foreground hover:bg-secondary" aria-label={t('paper.close')}><ArrowLeft size={17} /></button>
        <div className="min-w-0 flex-1"><p className="text-[11px] font-medium uppercase tracking-[0.14em] text-helix">{t('paper.title')}</p><h2 className="mt-1 text-lg font-semibold leading-snug">{view.title}</h2><p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{view.sourceLabel}{view.sourceHash ? ` · ${view.sourceHash}` : ''}</p></div>
        <Status status={view.status} />
      </header>
      {view.error ? <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{view.error}</p> : null}
      {view.interpretationStatus === 'not_started' ? <p role="status" className="mt-4 rounded-md border border-border bg-secondary px-3 py-2 text-xs text-muted-foreground">{t('paper.extractionOnly')}</p> : null}
      <nav aria-label={t('paper.tabs')} className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">{tabs.map(({ id, icon: Icon, key }) => <button key={id} type="button" aria-current={active === id ? 'page' : undefined} onClick={() => action({ type: 'paper.tab', tab: id })} className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${active === id ? 'border-helix/40 bg-helix-soft text-helix' : 'border-border bg-card text-muted-foreground hover:text-foreground'}`}><Icon size={14} />{t(key as MessageKey)}</button>)}</nav>
      <main className="mt-5 space-y-4">
        {active === 'interpretation' ? <section className="space-y-4">{view.summary ? <article className="rounded-xl border border-border bg-card p-4"><h3 className="text-sm font-semibold">{t('paper.summary')}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{view.summary}</p></article> : null}<article className="rounded-xl border border-border bg-card p-4"><h3 className="text-sm font-semibold">{t('paper.sections')}</h3><div className="mt-3 space-y-3">{view.sections.map((section, index) => <div key={`${section.label}-${index}`} className="border-l-2 border-helix/30 pl-3"><div className="flex gap-2 text-xs font-medium"><span>{section.label}</span>{section.page ? <span className="font-mono text-muted-foreground">p.{section.page}</span> : null}</div><p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{section.text}</p></div>)}</div></article></section> : null}
        {active === 'provenance' ? <section className="space-y-4"><article className="rounded-xl border border-border bg-card p-4"><h3 className="text-sm font-semibold">{t('paper.identifiers')}</h3><div className="mt-3 divide-y divide-border">{view.mentions.map(mention => <div key={mention.identifier} className="flex flex-wrap items-center gap-2 py-2 text-xs"><code className="font-mono text-helix">{mention.identifier}</code><span className="text-muted-foreground">{mention.relationship}</span><span className="rounded-full bg-secondary px-2 py-0.5 text-[10px]">{mention.matchTier ? `${t('paper.tier')} ${mention.matchTier}` : mention.verification}</span><button type="button" onClick={() => action({ type: 'paper.trace', identifier: mention.identifier })} className="ml-auto text-helix underline">{t('paper.verify')}</button></div>)}</div></article><article className="rounded-xl border border-border bg-card p-4"><h3 className="text-sm font-semibold">{t('paper.evidence')}</h3><div className="mt-3 space-y-3">{view.evidence.map(item => <button key={item.id} type="button" onClick={() => action({ type: 'paper.evidence', evidenceId: item.id })} className="block w-full rounded-lg border border-border p-3 text-left hover:border-helix/40"><div className="flex justify-between gap-2 text-[11px] text-muted-foreground"><span>{item.section}</span><span className="font-mono">p.{item.page}</span></div><p className="mt-1 text-xs leading-relaxed">“{item.quote}”</p><p className="mt-1 break-all font-mono text-[9px] text-muted-foreground">{item.id}</p></button>)}</div></article></section> : null}
        {active === 'plan' ? <section className="rounded-xl border border-border bg-card p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold">{t('paper.plan')}</h3><button type="button" disabled={!view.plan?.length} onClick={() => action({ type: 'paper.prepare_plan' })} className="rounded-md bg-helix px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40">{t('paper.prepare')}</button></div><div className="mt-3 space-y-2">{view.plan?.length ? view.plan.map((item, index) => <div key={index} className="rounded-lg border border-border p-3"><span className="text-[10px] uppercase tracking-wide text-helix">{t(`paper.planKind.${item.kind}` as MessageKey)}</span><p className="mt-1 text-xs leading-relaxed">{item.text}</p><div className="mt-2 flex flex-wrap gap-1">{item.evidenceIds.map(id => <span key={id} className="font-mono text-[9px] text-muted-foreground">{evidenceById.get(id)?.page ? `p.${evidenceById.get(id)?.page}` : id}</span>)}</div></div>) : <p className="text-xs text-muted-foreground">{t('paper.noPlan')}</p>}</div></section> : null}
        {active === 'workflow' ? <section className="rounded-xl border border-border bg-card p-4"><h3 className="text-sm font-semibold">{t('paper.workflow')}</h3><p className="mt-1 text-xs text-muted-foreground">{t('paper.workflowHint')}</p><div className="mt-4 space-y-2">{view.workflow?.length ? view.workflow.map(node => <div key={node.nodeId} className="flex items-start gap-3 rounded-lg border border-border p-3"><CircleDashed size={15} className="mt-0.5 shrink-0 text-helix" /><div className="min-w-0"><p className="text-xs font-medium">{node.label}</p><p className="mt-1 font-mono text-[10px] text-muted-foreground">{node.nodeId} · {node.state}{node.dependsOn.length ? ` · ${node.dependsOn.join(', ')}` : ''}</p></div></div>) : <p className="text-xs text-muted-foreground">{t('paper.noWorkflow')}</p>}</div></section> : null}
      </main>
    </div>
  </div>;
}
