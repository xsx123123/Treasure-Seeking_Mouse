import type { ResearchActionV1, ResearchWorkflowView } from './presentation-contract';
import { createContext, useContext } from 'react';
import type { LiteratureCardDTO } from './services/literature';
import type { UsageStats } from './services/seqoutChat';
import type { StatRow } from './services/statsStore';

/** Optional platform services: the original SPA retains its existing defaults. */
export interface PresentationServices {
  portalContainer: HTMLElement;
  onResearchAction?: (action: ResearchActionV1) => void;
  workflow?: ResearchWorkflowView;
  loadLiterature?: (kind: string, id: string) => Promise<LiteratureCardDTO>;
  loadUsage?: () => Promise<UsageStats | null>;
  loadLeaderboard?: () => Promise<{ users: StatRow[]; guests: StatRow[] }>;
  updateNickname?: (name: string) => Promise<{ ok: boolean; message?: string }>;
  viewport?: () => { width: number; height: number };
  theme?: 'light' | 'dark';
}
export const PresentationContext = createContext<PresentationServices | null>(null);
export const usePresentation = () => useContext(PresentationContext);
