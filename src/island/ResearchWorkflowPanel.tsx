import { requestKey as newRequestKey } from './requestKey';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { useI18n } from '../i18n/provider';
import type { ResearchActionV1, ResearchWorkflowView } from './contract';

/** Original themed dialog; all I/O and durable records are owned by the platform. */
export function ResearchWorkflowPanel({ view, action }: { view: ResearchWorkflowView; action: (value: ResearchActionV1) => void }): React.ReactElement {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<'raw' | 'processed'>('raw');
  const [budget, setBudget] = useState('67108864');
  const [requestKey, setRequestKey] = useState(() => newRequestKey());
  const [flow, setFlow] = useState('');
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [reference, setReference] = useState('');
  const [treatment, setTreatment] = useState('');
  const field = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px]';
  const button = 'rounded-md border border-border bg-card px-3 py-1.5 text-[12px] text-helix disabled:opacity-40';
  function changeSelection(values: string[]) { setSelected(values); setRequestKey(newRequestKey()); }
  const can = (tool: string) => view.allowedTools?.includes(tool) === true;
  const validBudget = Number.isSafeInteger(Number(budget)) && Number(budget) > 0;
  return <Dialog open={view.open} onOpenChange={open => { if (!open) action({ type: 'workflow.close' }); }}>
    <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
      <DialogHeader><DialogTitle>{t('workflow.title')}</DialogTitle></DialogHeader>
      <p className="text-[12px] text-muted-foreground">{t('workflow.prepareOnly')}</p>
      {!view.projectSelected ? <p role="status" className="text-[12px] text-pet-amber-deep">{t('workflow.projectRequired')}</p> : null}
      {view.error ? <p role="alert" className="text-[12px] text-destructive">{view.error}</p> : null}
      {view.busy ? <p role="status">{t('workflow.loading')}</p> : null}
      <div className="flex flex-wrap gap-2"><button className={button} disabled={view.busy || !view.projectSelected || !can('dataset.list_project_assets')} onClick={() => action({ type: 'dataset.list' })}>{t('workflow.assets')}</button><button className={button} disabled={view.busy || !can('tasks.list_related')} onClick={() => action({ type: 'records.refresh' })}>{t('workflow.records')}</button><button className={button} disabled={view.busy || !view.projectSelected || !can('research.project_delivery')} onClick={() => action({ type: 'delivery.read' })}>{t('workflow.delivery')}</button></div>
      <button className={button} disabled={view.busy} onClick={() => action({ type: 'capabilities.refresh' })}>{t('workflow.capabilities')}</button>
      <p role="status" className="text-[12px] text-muted-foreground">{view.catalogStatus === 'AVAILABLE' ? t('workflow.prepareOnly') : t('workflow.catalogUnavailable')}</p>
      {view.downloadCapabilities?.map(capability => <section key={capability.source} className="text-[12px] rounded-md border border-border p-2"><strong>{capability.source}</strong><p>{capability.states.join(' · ')}</p><p className="text-muted-foreground">{capability.reasons.join(' · ')}</p></section>)}
      {view.accession ? <section className="space-y-3 rounded-xl border border-border bg-secondary/30 p-3">
        <h3 className="font-display">{view.accession} · {view.status}</h3>
        <ul className="space-y-1 text-[12px] text-muted-foreground">{view.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>
        {view.sources.map(source => <p key={source.url} className="break-all text-[11px]"><a className="text-helix underline" href={source.url} target="_blank" rel="noreferrer noopener">{t('workflow.source')}</a> · {source.digest}</p>)}
        <h4 className="text-[12px] font-medium">{t('workflow.samples')}</h4>
        <ul className="max-h-40 space-y-1 overflow-auto text-[12px]">{view.samples.map(sample => <li key={sample.id}><code>{sample.id}</code> {sample.summary}</li>)}</ul>
        <ul className="max-h-32 overflow-auto font-mono text-[11px] text-muted-foreground">{view.relations.map((edge, i) => <li key={i}>{edge.from} → {edge.to} · {edge.relation}</li>)}</ul>
        <label className="block text-[12px]">{t('workflow.route')}<select className={field} value={mode} onChange={e => { setMode(e.target.value as 'raw' | 'processed'); changeSelection([]); }}><option value="raw">{t('workflow.raw')}</option><option value="processed">{t('workflow.processed')}</option></select></label>
        <div className="max-h-48 space-y-2 overflow-auto">{view.files.filter(file => file.mode === mode).map(file => <label key={file.id} className="flex gap-2 text-[12px]"><input type="checkbox" disabled={file.mode === 'raw' && !/^SRR\d+$/.test(file.id)} checked={selected.includes(file.id)} onChange={e => changeSelection(e.target.checked ? [...selected, file.id] : selected.filter(id => id !== file.id))} /><span className="break-all">{file.label} {file.mode === 'raw' && !/^SRR\d+$/.test(file.id) ? t('workflow.unsupportedRun') : ''} · {file.size === null ? t('workflow.sizeUnknown') : `${file.size} B`}</span></label>)}</div>
        {!view.files.some(file => file.mode === mode) ? <p className="text-[12px]">{t('workflow.noFiles')}</p> : null}
        <label className="block text-[12px]">{t('workflow.budget')}<input className={field} type="number" min="1" value={budget} onChange={e => { setBudget(e.target.value); setRequestKey(newRequestKey()); }} /></label>
        <button className={button} disabled={view.busy || !view.projectSelected || !selected.length || !validBudget || !can('dataset.prepare_import')} onClick={() => action({ type: 'dataset.prepare_import', discoveryRef: view.accession!, mode, selectedIds: selected, maxBytes: Number(budget), requestKey })}>{t('workflow.prepareImport')}</button>
      </section> : null}
      {view.datasets.map(dataset => <section key={dataset.id} className="space-y-2 rounded-xl border border-border p-3"><h3>{dataset.name}</h3><p className="text-[11px] text-muted-foreground">{t('workflow.versionsBounded')}</p>{dataset.versions.map(version => <button key={version.id} className={button} disabled={view.busy || !can('dataset.inspect')} onClick={() => action({ type: 'dataset.version', datasetId: dataset.id, versionId: version.id })}>{version.label}</button>)}</section>)}
      {view.versionId ? <section className="space-y-2 rounded-xl border border-border p-3"><h3>{t('workflow.handoff')}</h3><p className="break-all font-mono text-[11px]">{view.manifestHash || t('workflow.notFrozen')}</p>
        {view.assets.map(asset => <p key={asset.id} className="break-all text-[12px]">{asset.type} · {asset.role} · {asset.fileRecordId} · {asset.checksumStatus} · {asset.size} B · {asset.checksum} · {asset.availability}</p>)}
        <ul className="text-[12px] text-muted-foreground">{view.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>
        <label className="block text-[12px]">Flow<select className={field} value={flow} onChange={e => { setFlow(e.target.value); setParameters({}); }}><option value="">{t('workflow.selectFlow')}</option>{view.workflows.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        {!view.workflows.length ? <p className="text-[12px]">{t('workflow.noFlow')}</p> : null}
        {(flow === 'counts_deg' ? ['design'] : flow === 'rna_seq' ? ['species', 'Genome_Version', 'Library_Types'] : []).map(key => <label key={key} className="block text-[12px]">{key}<input className={field} value={parameters[key] ?? ''} onChange={e => setParameters({ ...parameters, [key]: e.target.value })} /></label>)}
        <label className="block text-[12px]">{t('workflow.reference')}<input className={field} value={reference} onChange={e => setReference(e.target.value)} /></label>
        <label className="block text-[12px]">{t('workflow.treatment')}<input className={field} value={treatment} onChange={e => setTreatment(e.target.value)} /></label>
        <button className={button} disabled={view.busy || !can('analysis.prepare_from_dataset') || !flow || !view.manifestHash || !reference || !treatment} onClick={() => action({ type: 'analysis.prepare', datasetId: view.datasetId!, versionId: view.versionId!, flowId: flow, parameters, reference, treatment })}>{t('workflow.prepareAnalysis')}</button>
      </section> : null}
      {view.proposals.map(proposal => <section key={proposal.id} className="space-y-2 rounded-xl border border-helix/30 bg-helix-soft/30 p-3"><h3>{t('workflow.proposal')} · {proposal.state}</h3><p className="break-all font-mono text-[11px]">{proposal.hash}</p><p className="text-[12px]">{proposal.expires}</p><dl className="text-[12px]">{proposal.details.map((item, i) => <div key={i} className="flex flex-wrap gap-2"><dt>{item.label}</dt><dd className="break-all">{item.value}</dd></div>)}</dl><div className="flex gap-2"><button className={button} disabled={view.busy || !can(proposal.kind === 'import' ? 'dataset.prepare_import' : 'analysis.prepare_from_dataset') || !['PREPARED','pending','PENDING'].includes(proposal.state)} onClick={() => action({ type: 'proposal.decide', proposalId: proposal.id, kind: proposal.kind, approve: true })}>{t('workflow.approve')}</button><button className={button} disabled={view.busy || !can(proposal.kind === 'import' ? 'dataset.prepare_import' : 'analysis.prepare_from_dataset') || !['PREPARED','pending','PENDING'].includes(proposal.state)} onClick={() => action({ type: 'proposal.decide', proposalId: proposal.id, kind: proposal.kind, approve: false })}>{t('workflow.reject')}</button></div><p className="text-[12px] text-muted-foreground">{t('workflow.blocked')}</p></section>)}
      <p className="text-[12px] text-muted-foreground">{t('workflow.deliveryState')} · {view.deliveryStatus}</p>
      {view.reports.map(report => <button key={report.id} className={button} onClick={() => action({ type: 'report.open', reportId: report.id })}>{report.kind} · {report.state} · {report.integrity}</button>)}
      {view.tasks.map(task => <button key={task.id} className={button} onClick={() => action({ type: 'task.open', taskId: task.id })}>{task.id} · {task.status}</button>)}
    </DialogContent>
  </Dialog>;
}
