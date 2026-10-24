// 登录 / 注册弹窗（自托管本地账号形态：走 server/account-api.mjs，注册即登录、无邮箱验证）
// 云端登录是可选扩展点（见 cloudAdapter.ts）；接入后在此补云端分支即可。
import { useState } from "react";
import { localLogin, localRegister, type LocalUser } from "@/services/localAuth";
import { useI18n } from "@/i18n/provider";

type Mode = "login" | "register";

function errText(t: ReturnType<typeof useI18n>["t"], e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/邮箱或密码不正确/.test(m)) return t("auth.errInvalidCredentials");
  if (/already registered|already exists|已注册/.test(m)) return t("auth.errExists");
  return m;
}

export function AuthDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: (user: LocalUser) => void;
}): React.ReactElement | null {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ type: "error" | "ok"; text: string } | null>(null);

  if (!open) return null;

  function switchMode(m: Mode): void {
    setMode(m);
    setMsg(null);
  }

  async function handleSubmit(): Promise<void> {
    if (password.length < 6) {
      setMsg({ type: "error", text: t("auth.errPasswordShort") });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const user = mode === "login"
        ? await localLogin(email.trim(), password)
        : await localRegister(email.trim(), password, name.trim());
      onSuccess(user);
    } catch (e) {
      setMsg({ type: "error", text: errText(t, e) });
    } finally {
      setBusy(false);
    }
  }

  const fieldCls = "h-10 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground shadow-soft outline-none transition-colors focus-visible:border-helix focus-visible:ring-2 focus-visible:ring-helix/20";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="overlay-dim fixed inset-0" onClick={onClose} />
      <div className="relative w-full max-w-[400px] rounded-xl border border-border bg-card p-5 shadow-soft-lg">
        <h2 className="text-base font-semibold tracking-tight">
          {mode === "login" ? t("auth.loginTitle") : t("auth.registerTitle")}
        </h2>
        <p className="mt-1 text-cap text-muted-foreground">
          {mode === "login" ? t("auth.loginSub") : t("auth.registerSub")}
        </p>

        <div className="space-y-3.5 pt-3">
          <div className="space-y-1.5">
            <label htmlFor="auth-email" className="text-xs text-muted-foreground">{t("auth.email")}</label>
            <input
              id="auth-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={fieldCls}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="auth-pass" className="text-xs text-muted-foreground">{t("auth.password")}</label>
            <input
              id="auth-pass"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "register" ? t("auth.passwordPlaceholderRegister") : "••••••••"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={fieldCls}
            />
          </div>

          {mode === "register" ? (
            <div className="space-y-1.5">
              <label htmlFor="auth-name" className="text-xs text-muted-foreground">{t("auth.nickname")}</label>
              <input
                id="auth-name"
                maxLength={24}
                placeholder={t("auth.nicknamePlaceholder")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={fieldCls}
              />
            </div>
          ) : null}

          {msg ? (
            <p className={`rounded-md border px-3 py-2 text-cap leading-relaxed ${msg.type === "error" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-helix/30 bg-helix-soft text-helix"}`}>
              {msg.text}
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={busy || !email || !password}
            className="h-10 w-full rounded-lg bg-primary text-sm font-medium text-primary-foreground shadow-soft transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? t("auth.busyLogin") : mode === "login" ? t("auth.login") : t("auth.register")}
          </button>

          <div className="flex items-center justify-between pt-1 text-cap text-muted-foreground">
            {mode === "login" ? (
              <button type="button" className="hover:text-helix" onClick={() => switchMode("register")}>{t("auth.createAccount")}</button>
            ) : (
              <button type="button" className="mx-auto hover:text-helix" onClick={() => switchMode("login")}>{t("auth.backToLogin")}</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}