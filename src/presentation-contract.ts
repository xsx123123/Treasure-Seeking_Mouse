// Migrated from src/island/contract.ts before the island experiment was archived; the archived copy is a frozen snapshot.

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