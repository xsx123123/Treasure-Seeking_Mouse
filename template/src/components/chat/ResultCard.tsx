// 结果卡片（泛化）：tool/accession/title/summary 全字符串渲染 + meta 键值对展示。
// 卡片信封 {tool, accession, title, summary, meta: Record<string,string>} 形状冻结，
// meta 键集合由使用者的领域工具定义（示例见 demo_cards / weather 模块的投影）。
import { ExternalLink } from "lucide-react";
import type { ResultCard as CardData } from "@/services/chatClient";
import { useI18n } from "@/i18n/provider";

/** meta 中可点击的外链键约定：值以 http(s) 开头即渲染为外链（使用者可自行扩展键集合） */
function linkOf(meta: Record<string, string>): { key: string; url: string } | null {
  for (const [key, value] of Object.entries(meta)) {
    if (/^https?:\/\//i.test(value)) return { key, url: value };
  }
  return null;
}

export function ResultCardView({ card }: { card: CardData }): React.ReactElement {
  const { t } = useI18n();
  const meta = card.meta ?? {};
  const link = linkOf(meta);
  // meta 通用展示：过滤掉链接类与超长值（超 28 字符截断）
  const metaEntries = Object.entries(meta).filter(
    ([k, v]) => v && k !== "source" && !/^https?:\/\//i.test(v),
  );
  return (
    <div className="card-in relative overflow-hidden rounded-lg border border-border bg-card p-2.5 pl-3.5 shadow-soft before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-gradient-to-b before:from-gold/70 before:to-helix/50">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {meta.source ? (
            <span className="shrink-0 rounded bg-helix-soft px-1 py-px font-mono text-xs font-semibold uppercase text-helix ring-1 ring-helix/20">
              {meta.source}
            </span>
          ) : null}
          {!card.accession.trim() ? (
            <span className="shrink-0 rounded bg-secondary px-1 py-px text-xs font-medium text-muted-foreground ring-1 ring-border">
              {t("card.noIdentifier")}
            </span>
          ) : null}
          <span className="font-mono text-cap font-semibold tracking-wide text-helix">
            {card.accession.toUpperCase()}
          </span>
        </div>
        {link ? (
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            className="shrink-0 text-muted-foreground transition-colors hover:text-helix"
            title={t("card.openDetail")}
          >
            <ExternalLink size={12} />
          </a>
        ) : null}
      </div>
      <p className="mt-1 line-clamp-1 text-cap leading-snug text-foreground">{card.title}</p>
      {metaEntries.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-x-2.5 gap-y-0.5">
          {metaEntries.slice(0, 3).map(([k, v]) => (
            <span key={k} className="text-xs text-muted-foreground">
              <span className="text-muted-foreground/70">{k}: </span>
              {String(v).length > 28 ? `${String(v).slice(0, 28)}…` : v}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ResultCardGrid({ cards }: { cards: CardData[] }): React.ReactElement | null {
  if (!cards || cards.length === 0) return null;
  return (
    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {cards.map((c, i) => (
        <ResultCardView key={`${c.accession}-${i}`} card={c} />
      ))}
    </div>
  );
}