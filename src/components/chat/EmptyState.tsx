import { useRef, useState, type ReactNode } from "react";
import { ArrowUpLeft, BookOpen, ChevronDown, Database, Fingerprint, Microscope } from "lucide-react";
import { useI18n } from "@/i18n/provider";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import mouseBase from "@/assets/pet/mouse-base.webp";
import mouseWink from "@/assets/pet/mouse-wink.webp";

const TASKS = [
  { id: "discover", icon: Database },
  { id: "trace", icon: Fingerprint },
  { id: "interpret", icon: Microscope },
  { id: "literature", icon: BookOpen },
] as const;

export function EmptyState({ onPick, composer }: { onPick: (q: string) => void; composer: ReactNode }): React.ReactElement {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [eggOpen, setEggOpen] = useState(false);
  const clicks = useRef({ count: 0, last: 0 });
  function poke(): void {
    const now = Date.now();
    clicks.current.count = now - clicks.current.last < 1500 ? clicks.current.count + 1 : 1;
    clicks.current.last = now;
    if (clicks.current.count >= 3) {
      clicks.current.count = 0;
      setEggOpen(true);
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-[820px] flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex items-center gap-3">
        <button type="button" onClick={poke} title={t("easterEgg.hint")} aria-label={t("easterEgg.hint")} className="h-14 w-14 shrink-0 rounded-lg bg-pet-gold-soft transition-transform active:scale-95">
          <img src={mouseBase} alt={t("pet.alt")} className="h-full w-full object-contain" />
        </button>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-helix">{t("brand.name")}</p>
          <h1 className="mt-1 text-[22px] font-semibold leading-snug sm:text-[26px]">{t("empty.headline")}</h1>
        </div>
      </div>
      <p className="-mt-2 text-sm leading-relaxed text-muted-foreground">{t("empty.subHeadline")}</p>
      {composer}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        {TASKS.map(({ id, icon: Icon }) => (
          <section key={id} className="overflow-hidden rounded-lg border border-border bg-card shadow-soft transition-colors hover:border-helix/40">
            <button type="button" aria-expanded={expanded === id} aria-controls={expanded === id ? `examples-${id}` : undefined} onClick={() => setExpanded(expanded === id ? null : id)} className="task-entry flex min-h-[116px] w-full gap-3 p-4 text-left transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-helix">
              <Icon size={19} className={`mt-0.5 shrink-0 ${id === "literature" ? "text-gold" : "text-helix"}`} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold">{t(`empty.${id}.title`)}</span>
                  <span className="text-[11px] text-muted-foreground">{t(`empty.${id}.alias`)}</span>
                </span>
                <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">{t(`empty.${id}.description`)}</span>
              </span>
              <ChevronDown size={15} className={`mt-1 shrink-0 text-muted-foreground transition-transform ${expanded === id ? "rotate-180" : ""}`} />
            </button>
            {expanded === id && (
              <ul id={`examples-${id}`} className="border-t border-border px-3 py-2">
                {(["one", "two"] as const).map((n) => (
                  <li key={n}>
                    <button type="button" onClick={() => onPick(t(`empty.${id}.${n}`))} className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs leading-relaxed transition-colors hover:bg-secondary hover:text-helix focus-visible:outline-2 focus-visible:outline-helix">
                      <ArrowUpLeft size={14} className="mt-0.5 shrink-0 text-helix" />{t(`empty.${id}.${n}`)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      <p className="text-center text-[11px] leading-relaxed text-muted-foreground">{t("empty.sources")}</p>
      <Dialog open={eggOpen} onOpenChange={setEggOpen}>
        <DialogContent className="border-border bg-card text-center sm:max-w-[380px]">
          <img src={mouseWink} alt={t("pet.alt")} className="mx-auto h-24 w-24 object-contain" />
          <DialogTitle>{t("easterEgg.title")}</DialogTitle>
          <p className="text-sm leading-relaxed text-muted-foreground">{t("easterEgg.body")}</p>
          <button type="button" onClick={() => setEggOpen(false)} className="rounded-lg bg-primary p-3 text-sm text-primary-foreground">{t("easterEgg.close")}</button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
