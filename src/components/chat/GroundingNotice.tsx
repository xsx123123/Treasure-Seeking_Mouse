// grounding 警示条：正文引用但未在本次检索结果中证实的编号清单（默认折叠灰条，展开逐条列出）
import { useState } from "react";
import { ChevronDown, ShieldAlert } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import type { GroundingItem } from "@/services/seqoutChat";

export function GroundingNotice({ unconfirmed }: { unconfirmed: GroundingItem[] }): React.ReactElement | null {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!unconfirmed || unconfirmed.length === 0) return null;
  return (
    <div className="card-in mt-2 overflow-hidden rounded-lg border border-border bg-secondary/50 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-secondary/70"
      >
        <ShieldAlert size={13} className="shrink-0 text-pet-amber-deep" />
        <span className="text-[12.5px] font-medium text-foreground/80">{t("grounding.title")}</span>
        <span className="rounded-full bg-card px-1.5 py-px font-mono text-[10px] text-muted-foreground ring-1 ring-border">
          {unconfirmed.length}
        </span>
        <ChevronDown size={14} className={`ml-auto shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="border-t border-border/70 px-3 py-2">
          <p className="text-[12px] leading-relaxed text-muted-foreground">{t("grounding.notice")}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {unconfirmed.map((u) => (
              <code
                key={u.id}
                className="rounded border border-border bg-card px-1.5 py-px font-mono text-[11px] text-foreground/85"
              >
                {u.id}
              </code>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
