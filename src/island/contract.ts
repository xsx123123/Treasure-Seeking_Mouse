/** Non-sensitive view data only. Authentication, networking and state belong to Vue. */
export interface TreasureCard {
  tool: string; accession: string; title: string; summary: string; meta: Record<string, string>;
}
export interface TreasureMessage {
  id: string; role: 'user' | 'assistant'; content: string;
  cards?: TreasureCard[]; toolLogs?: { name: string; label: string; ok: boolean; ms: number }[];
  liveTools?: { name: string; label: string; status: 'running' | 'done' | 'error'; ms?: number }[];
  grounding?: { unconfirmed: { id: string; status: string }[]; confirmed: string[] } | null;
  boost?: { accession: string | null } | null;
  streaming?: boolean; error?: string | null;
}
export interface TreasureIslandProps {
  context: { projectId: string | null; projectName: string; locale: 'zh' | 'en'; theme: 'light' | 'dark' };
  messages: readonly TreasureMessage[];
  mode?: 'welcome' | 'composer' | 'pet' | 'app';
  modelOptions: readonly string[]; selectedModel: string;
  draft: string; streaming: boolean; disabled: boolean;
  sessions?: { id: string; title: string; updated_at: string }[];
  activeSessionId?: string | null;
  projects?: { id: string; name: string }[];
  loading?: boolean; accessError?: string; historyError?: string; streamError?: string;
  onDraftChange: (draft: string) => void; onSubmit: (text: string) => void;
  onPickExample: (text: string) => void; onCancel: () => void;
  onSelectModel: (model: string) => void; onOpenDataset: (accession: string) => void;
  onSelectSession?: (id: string) => void; onNewSession?: () => void;
  onRenameSession?: (id: string, title: string) => void; onArchiveSession?: (id: string) => void;
  onChangeProject?: (id: string) => void; onRefresh?: () => void;
  onLocaleChange?: (lang: 'zh' | 'en') => void; onThemeChange?: () => void;
  workflow?: ResearchWorkflowView;
  onResearchAction?: (action: ResearchActionV1) => void;
  paperWorkspace?: PaperWorkspaceView;
  onPaperAction?: (action: PaperActionV1) => void;
  paperMode?: boolean;
  onRegenerate?: (id: string) => void;
  loadLiterature?: (kind: string, id: string) => Promise<{
    status: 'ok' | 'not_found'; pmid?: string; title?: string; journal?: string; year?: string;
    doi?: string; outline?: { section: string; text: string }[];
    urls?: { pubmed?: string; doi?: string; full_text?: string }; suggested_queries?: string[];
  }>;
}
export interface TreasureIslandHandle { update: (props: TreasureIslandProps) => void; unmount: () => void; }

/** Safe UI intents. No credentials, owner IDs or executable server paths; a selected PDF is user input handed to the platform owner for validation. */
export type ResearchActionV1 =
  | { type: 'capabilities.refresh' }
  | { type: 'dataset.inspect'; discoveryRef: string }
  | { type: 'dataset.prepare_import'; discoveryRef: string; mode: 'raw' | 'processed'; selectedIds: string[]; maxBytes: number; requestKey: string }
  | { type: 'dataset.list' }
  | { type: 'dataset.version'; datasetId: string; versionId: string }
  | { type: 'analysis.prepare'; datasetId: string; versionId: string; flowId: string; parameters: Record<string, string>; reference: string; treatment: string }
  | { type: 'records.refresh' }
  | { type: 'delivery.read' }
  | { type: 'proposal.decide'; proposalId: string; kind: 'import' | 'analysis'; approve: boolean }
  | { type: 'task.open'; taskId: string }
  | { type: 'report.open'; reportId: string }
  | { type: 'workflow.close' };

export type PaperTab = 'interpretation' | 'provenance' | 'plan' | 'workflow';
export interface PaperEvidenceView {
  id: string; page: number; section: string; quote: string; context?: string;
  figure?: string | null; table?: string | null;
}
export interface PaperWorkspaceView {
  open: boolean; status: 'queued' | 'running' | 'partial' | 'succeeded' | 'failed';
  interpretationStatus?: 'not_started' | 'partial' | 'completed';
  title: string; sourceLabel: string; sourceHash?: string; error?: string;
  activeTab?: PaperTab;
  summary?: string; sections: { label: string; page?: number; text: string }[];
  evidence: PaperEvidenceView[];
  mentions: { identifier: string; relationship: string; verification: string; matchTier?: 'A' | 'B' | 'C' | null; evidenceIds: string[] }[];
  plan?: { kind: 'method' | 'recommendation' | 'assumption'; text: string; evidenceIds: string[] }[];
  workflow?: { nodeId: string; label: string; state: string; dependsOn: string[] }[];
}
export type PaperActionV1 =
  | { type: 'paper.input'; input: { kind: 'pdf'; file: File } }
  | { type: 'paper.close' }
  | { type: 'paper.tab'; tab: PaperTab }
  | { type: 'paper.evidence'; evidenceId: string }
  | { type: 'paper.trace'; identifier: string }
  | { type: 'paper.prepare_plan' };
export interface ResearchWorkflowView {
  open: boolean; busy: boolean; error?: string; projectSelected: boolean;
  allowedTools?: string[];
  catalogStatus?: 'UNKNOWN' | 'AVAILABLE' | 'UNAVAILABLE';
  downloadCapabilities?: { source: string; states: string[]; reasons: string[]; executionAllowed: false }[];
  accession?: string; status?: string; gaps: string[];
  samples: { id: string; summary: string }[];
  relations: { from: string; to: string; relation: string }[];
  files: { id: string; label: string; mode: 'raw' | 'processed'; size: number | null }[];
  datasets: { id: string; name: string; versions: { id: string; label: string }[] }[];
  datasetId?: string; versionId?: string; manifestHash?: string;
  assets: { id: string; type: string; size: number; checksum: string; availability: string; fileRecordId?: string; role?: string; checksumStatus?: string }[];
  workflows: { id: string; label: string }[];
  proposals: { id: string; kind: 'import' | 'analysis'; state: string; hash: string; expires: string; details: { label: string; value: string }[] }[];
  tasks: { id: string; status: string }[];
  reports: { id: string; kind: string; state: string; integrity: string }[];
  deliveryStatus: string;
  sources: { url: string; digest: string }[];
}
