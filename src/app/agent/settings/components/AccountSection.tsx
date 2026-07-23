"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { type TFunc } from "@/lib/i18n";
// NOTE: the privacy-toggle block below is commented out, so ToggleSwitch is not imported here.
// Restore the import from "./ToggleSwitch" along with that block if it is ever re-enabled.

/** Account section: account info + privacy mode + sign out / sign in. */
export function AccountSection({
  t,
  name,
  sub,
  isLoggedIn,
  onLogout,
  onSignIn,
}: {
  t: TFunc;
  name: string;
  sub: string;
  isLoggedIn: boolean;
  onLogout: () => void;
  onSignIn: () => void;
}) {
  const [privacy, setPrivacy] = useState(false);
  return (
    <div className="max-w-2xl">
      <h2 className="mb-5 text-xl font-bold text-ink">{t("settings.account")}</h2>

      {/* <p className="mb-2 text-sm font-semibold text-ink">{t("account.info")}</p>
      <div className="mb-6 divide-y divide-line rounded-xl border border-line bg-surface-muted/50">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{name}</p>
            {sub && <p className="truncate text-xs text-ink-subtle">{sub}</p>}
          </div>
          <button className="shrink-0 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted">
            {t("account.manage")}
          </button>
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{t("plan.free")}</p>
            <p className="text-xs text-ink-subtle">{t("account.upgradeDesc")}</p>
          </div>
          <button className="shrink-0 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted">
            {t("account.upgrade")}
          </button>
        </div>
      </div>

      <p className="mb-2 text-sm font-semibold text-ink">{t("account.privacy")}</p>
      <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-muted/50 px-4 py-3">
        <p className="text-xs text-ink-subtle">{t("account.privacyDesc")}</p>
        <ToggleSwitch on={privacy} onChange={setPrivacy} label={t("account.privacy")} />
      </div> */}

      {isLoggedIn ? (
        <button
          onClick={onLogout}
          className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-destructive transition hover:bg-surface-muted"
        >
          <LogOut className="size-4" />
          {t("account.logout")}
        </button>
      ) : (
        <button
          onClick={onSignIn}
          className="flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-surface-muted"
        >
          <LogOut className="size-4" />
          {t("auth.signIn")}
        </button>
      )}
    </div>
  );
}
