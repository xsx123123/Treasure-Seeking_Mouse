// 空态：欢迎语 + composer + 示例任务卡（示例工具演示入口，点击直接作为提问发送）
import type { ReactNode } from "react";
import { ArrowUpLeft, Bot, Database, ListChecks, Wand2 } from "lucide-react";
import { useI18n } from "@/i18n/provider";

const TASKS = [
  { id: "taskEcho", icon: Wand2 },
  { id: "taskCards", icon: Database },
  { id: "taskPlan", icon: ListChecks },
] as const;

export function EmptyState({ onPick, composer, submitting }: { onPick: (q: string) => void; composer: ReactNode; submitting: boolean }): React.ReactElement {
  const { t } = useI18n();
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[820px] flex-col px-4 sm:px-6">
      <div className="my-auto flex flex-col gap-5 py-6 sm:py-8">
      <div className="flex items-center gap-3">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-helix-soft ring-1 ring-helix/30">
          <Bot size={28} className="text-helix" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-helix">{t("brand.name")}</p>
          <h1 className="mt-1 text-display font-semibold leading-snug sm:text-[26px]">{t("empty.headline")}</h1>
        </div>
      </div>
      <p className="-mt-2 text-sm leading-relaxed text-muted-foreground">{t("empty.subHeadline")}</p>
      {composer}
      <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2">
        {TASKS.map(({ id, icon: Icon }) => (
          <section key={id} className="flex flex-col rounded-lg border border-border bg-card p-4 shadow-soft transition-colors hover:border-helix/40">
            <div className="flex min-h-[72px] gap-3">
              <Icon size={19} className="mt-0.5 shrink-0 text-helix" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold">{t(`empty.${id}.title`)}</span>
                </span>
                <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">{t(`empty.${id}.description`)}</span>
              </span>
            </div>
            <ul className="mt-2 border-t border-border pt-2">
              {(["one", "two"] as const).map((n) => (
                <li key={n}>
                  <button type="button" disabled={submitting} onClick={() => onPick(t(`empty.${id}.${n}`))} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs leading-relaxed transition-colors hover:bg-secondary hover:text-helix focus-visible:outline-2 focus-visible:outline-helix disabled:cursor-not-allowed disabled:opacity-50">
                    <ArrowUpLeft size={14} className="mt-0.5 shrink-0 text-helix" /><span>{t(`empty.${id}.${n}`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="text-center text-xs leading-relaxed text-muted-foreground">{t("empty.sources")}</p>
      </div>
    </div>
  );
}