"use client";

import { LogIn, LogOut, User } from "lucide-react";
import { type TFunc } from "@/lib/i18n";
import { Group, Pane, PANEL } from "./pane";
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
  return (
    <Pane title={t("settings.account")}>
      {/* Who you are signed in as. It used to be that this pane said nothing at all about the
          account until you noticed which of the two buttons it was showing. */}
      <Group title={t("account.info")} icon={User} anchor="account/info">
        <div className={PANEL}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{isLoggedIn ? name : t("account.guest")}</p>
              <p className="truncate text-xs text-ink-subtle">
                {isLoggedIn ? sub || t("account.signedIn") : t("account.guestDesc")}
              </p>
            </div>
            {isLoggedIn ? (
              <button
                onClick={onLogout}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-destructive transition hover:bg-surface-muted"
              >
                <LogOut className="size-3.5" />
                {t("account.logout")}
              </button>
            ) : (
              <button
                onClick={onSignIn}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted"
              >
                <LogIn className="size-3.5" />
                {t("auth.signIn")}
              </button>
            )}
          </div>
        </div>
      </Group>

      {/* Parked, not deleted: the plan / privacy blocks below are switched off, not gone. Kept as a
          comment so re-enabling them is a matter of uncommenting plus restoring the ToggleSwitch
          import, and so the copy keys they use stay accounted for.

      <Group title={t("account.privacy")} anchor="account/privacy">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-muted/40 px-4 py-3">
          <p className="text-xs text-ink-subtle">{t("account.privacyDesc")}</p>
          <ToggleSwitch on={privacy} onChange={setPrivacy} label={t("account.privacy")} />
        </div>
      </Group>

      <Group title={t("plan.free")} anchor="account/plan">
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-muted/40 px-4 py-3">
          <p className="text-xs text-ink-subtle">{t("account.upgradeDesc")}</p>
          <button className="shrink-0 rounded-md border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:bg-surface-muted">
            {t("account.upgrade")}
          </button>
        </div>
      </Group>
      */}
    </Pane>
  );
}
