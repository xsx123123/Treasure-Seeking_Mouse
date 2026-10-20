// ProtocolCard：实验方案卡片（protocols_search / protocols_get_details / protocols_get_steps）
// P3 完整版：操作区「查看步骤与材料」经 onViewSteps 回调走现有 handleSend 通道（与
// SuggestionBlock 点击 followup 完全同构——预置提问「展开方案 {title} 的完整步骤与材料」
// → 模型路由 protocols_get_steps → 新消息流呈现，不新建交互范式，design §2.7）；
// 「详情」打开 ProtocolDetailDialog（对齐 LiteratureDetailDialog 形态，展示 meta 全量概要）；
// has_warning 时警告段以 pet-amber 色系独立样式呈现（视觉可辨识，非普通样式，spec 5.5.1 规则 4）。
// 设计依据 design §2.7：protocols.io 徽章 + peer_reviewed 三态徽章（'true'→teal、'false'/键不设→muted，
// hover 承载限定语、不出现「已验证可靠」类绝对化文案，spec 5.7.1 规则 4）+ 版本徽章；
// 时间三分分立呈现（published_at / version_id / retrieved_at 各自独立，spec 5.4.1 规则 3）；
// 「打开原文」meta.url 外链是唯一允许的新窗口场景（spec 5.6.1 规则 2）；
// 卡片不内嵌完整步骤（体积决策，概要与计数进 meta，完整层经 get_steps 信封由模型正文呈现）。
// 样式合规：一律消费 theme utility（bg-card / text-helix / text-pet-amber 等），文案全部走 t()。
import { useState } from "react";
import { AlertTriangle, ExternalLink, Info, ListOrdered } from "lucide-react";
import type { ReactElement } from "react";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/i18n/provider";
import type { DatasetCard as CardData } from "@/services/seqoutChat";

function formatTs(iso: string | undefined): string {
  if (!iso) return "";
  return iso.length >= 16 ? iso.slice(0, 16).replace("T", " ") : iso;
}

/** peer_reviewed 三态徽章（键缺省=未知态，spec 6.4.3）；hover/title 承载限定语，禁绝对化文案 */
function ReviewBadge({ state }: { state: string | undefined }): ReactElement {
  const { t } = useI18n();
  const label =
    state === "true" ? t("protocol.peerReviewed") : state === "false" ? t("protocol.notPeerReviewed") : t("protocol.peerReviewUnknown");
  const cls =
    state === "true"
      ? "bg-helix-soft text-helix ring-helix/20"
      : "bg-secondary text-muted-foreground ring-border";
  return (
    <span className={`shrink-0 rounded px-1.5 py-px text-xs font-medium ring-1 ${cls}`} title={t("protocol.peerReviewCaveat")}>
      {label}
    </span>
  );
}

/** has_warning 警告段（卡片与详情 Dialog 共用）：pet-amber 色系独立样式，长文本内部滚动（窄屏形态） */
function WarningSection({ text }: { text: string | undefined }): ReactElement {
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-pet-amber/30 bg-pet-amber/10 px-2.5 py-2">
      <p className="flex items-center gap-1 text-xs font-semibold text-pet-amber">
        <AlertTriangle size={11} className="shrink-0" />
        {t("protocol.warning")}
      </p>
      {text ? (
        <p className="mt-1 max-h-40 overflow-y-auto text-cap leading-relaxed text-foreground/80">{text}</p>
      ) : null}
    </div>
  );
}

export function ProtocolResultCard({ card, onViewSteps }: { card: CardData; onViewSteps?: (q: string) => void }): ReactElement {
  const { t } = useI18n();
  const [detailOpen, setDetailOpen] = useState(false);
  const meta = card.meta ?? {};
  const url = meta.url || undefined;
  const doi = meta.doi || undefined;
  const doiLink = doi ? `https://doi.org/${doi}` : undefined;
  const retrieved = formatTs(meta.retrieved_at);
  const hasWarning = meta.has_warning === "true";

  const metaParts: string[] = [];
  if (meta.steps_count) metaParts.push(t("protocol.stepsCount", { n: meta.steps_count }));
  if (meta.materials_count) metaParts.push(t("protocol.materialsCount", { n: meta.materials_count }));
  if (meta.published_at) metaParts.push(t("protocol.publishedAt", { date: meta.published_at }));
  if (retrieved) metaParts.push(t("protocol.retrievedAt", { ts: retrieved }));

  return (
    <article className="hover-lift card-in relative overflow-hidden rounded-lg border border-helix/25 bg-card p-3 shadow-soft">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="shrink-0 rounded bg-helix-soft px-1.5 py-px font-mono text-xs font-semibold lowercase text-helix ring-1 ring-helix/20">
          protocols.io
        </span>
        <ReviewBadge state={meta.peer_reviewed} />
        {meta.version_id ? (
          <span className="shrink-0 rounded bg-secondary px-1.5 py-px text-xs text-muted-foreground ring-1 ring-border">
            {t("protocol.version", { v: meta.version_id })}
          </span>
        ) : null}
        <span className="font-mono text-xs text-muted-foreground">#{card.accession}</span>
      </div>
      <h3 className="line-clamp-2 text-cap font-semibold leading-snug text-foreground">{card.title}</h3>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {[meta.authors, meta.affiliations].filter(Boolean).join(" · ")}
      </p>
      {metaParts.length > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{metaParts.join(" · ")}</p>
      ) : null}
      {card.summary?.trim() ? (
        <p className="mt-2 line-clamp-4 text-xs leading-relaxed text-foreground/80">{card.summary.trim()}</p>
      ) : null}
      {hasWarning ? (
        <div className="mt-2">
          <WarningSection text={meta.warning} />
        </div>
      ) : null}
      {meta.materials_unavailable === "true" ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground/80">{t("protocol.materialsUnavailable")}</p>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2">
        {onViewSteps ? (
          <button
            type="button"
            onClick={() => onViewSteps(t("protocol.stepsQuery", { title: card.title }))}
            className="story-link inline-flex items-center gap-1 text-xs text-helix"
            title={t("protocol.viewSteps")}
          >
            <ListOrdered size={10} />
            {t("protocol.viewSteps")}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setDetailOpen(true)}
          className="story-link inline-flex items-center gap-1 text-xs text-helix"
          title={t("protocol.detailTitle")}
        >
          <Info size={10} />
          {t("protocol.detailTitle")}
        </button>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="story-link inline-flex items-center gap-1 text-xs text-helix"
            title={t("protocol.openOriginal")}
          >
            <ExternalLink size={10} />
            {t("protocol.openOriginal")}
          </a>
        ) : null}
        {doiLink ? (
          <a
            href={doiLink}
            target="_blank"
            rel="noreferrer noopener"
            className="story-link inline-flex items-center gap-1 text-xs text-helix"
            title={doi}
          >
            <ExternalLink size={10} />
            {t("protocol.doi")}
          </a>
        ) : null}
        <span className="ml-auto text-[10px] text-muted-foreground/70">{t("protocol.sourceOriginal")}</span>
      </div>
      {detailOpen ? <ProtocolDetailDialog card={card} onClose={() => setDetailOpen(false)} /> : null}
    </article>
  );
}

/** 详情 Dialog：展示 meta 全量概要（对齐 LiteratureDetailDialog 形态；长内容 max-h + overflow-y-auto 内部滚动） */
function ProtocolDetailDialog({ card, onClose }: { card: CardData; onClose: () => void }): ReactElement {
  const { t } = useI18n();
  const meta = card.meta ?? {};
  const url = meta.url || undefined;
  const doiLink = meta.doi ? `https://doi.org/${meta.doi}` : undefined;
  const retrieved = formatTs(meta.retrieved_at);
  // meta 全量概要（存在才展示；时间三分分立：published_at / version_id / retrieved_at 各自独立行）
  const rows: [string, string][] = [];
  if (meta.authors) rows.push([t("protocol.detailAuthors"), meta.authors]);
  if (meta.affiliations) rows.push([t("protocol.detailAffiliations"), meta.affiliations]);
  if (meta.steps_count) rows.push([t("protocol.stepsCount", { n: meta.steps_count }), ""]);
  if (meta.materials_count) rows.push([t("protocol.materialsCount", { n: meta.materials_count }), ""]);
  if (meta.version_id) rows.push([t("protocol.version", { v: meta.version_id }), ""]);
  if (meta.published_at) rows.push([t("protocol.publishedAt", { date: meta.published_at }), ""]);
  if (retrieved) rows.push([t("protocol.retrievedAt", { ts: retrieved }), ""]);
  const factRows = rows.filter(([, v]) => v !== "").map(([k]) => k);
  const factList = factRows.join(" · ");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="shrink-0 rounded bg-helix-soft px-1.5 py-px font-mono text-xs font-semibold lowercase text-helix ring-1 ring-helix/20">
              protocols.io
            </span>
            <ReviewBadge state={meta.peer_reviewed} />
            <span className="font-mono text-xs text-muted-foreground">#{card.accession}</span>
            {meta.uri ? <span className="font-mono text-xs text-muted-foreground">{meta.uri}</span> : null}
            {meta.doi ? <span className="font-mono text-xs text-muted-foreground">DOI: {meta.doi}</span> : null}
          </div>
          <DialogTitle className="text-sm leading-snug">{card.title}</DialogTitle>
        </DialogHeader>
        {factList ? <p className="text-xs text-muted-foreground">{factList}</p> : null}
        {card.summary?.trim() ? (
          <section>
            <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">{t("protocol.detailSummary")}</h4>
            <p className="max-h-56 overflow-y-auto rounded-md border border-border/60 bg-secondary/40 px-3 py-2 text-cap leading-relaxed text-foreground/85">
              {card.summary.trim()}
            </p>
          </section>
        ) : null}
        {meta.has_warning === "true" ? <WarningSection text={meta.warning} /> : null}
        {meta.materials_unavailable === "true" ? (
          <p className="text-xs text-muted-foreground/80">{t("protocol.materialsUnavailable")}</p>
        ) : null}
        {url || doiLink ? (
          <section>
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">{t("protocol.detailLinks")}</h4>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {url ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="story-link inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-helix shadow-soft transition-colors hover:border-helix/40"
                >
                  <ExternalLink size={10} />
                  {t("protocol.openOriginal")}
                </a>
              ) : null}
              {doiLink ? (
                <a
                  href={doiLink}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="story-link inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-helix shadow-soft transition-colors hover:border-helix/40"
                >
                  <ExternalLink size={10} />
                  {t("protocol.doi")}
                </a>
              ) : null}
            </div>
          </section>
        ) : null}
        <p className="text-[10px] text-muted-foreground/70">{t("protocol.sourceOriginal")}</p>
      </DialogContent>
    </Dialog>
  );
}