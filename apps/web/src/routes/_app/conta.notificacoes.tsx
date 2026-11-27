/** Preferências de notificação (§6.10): por tipo, no app, por e-mail e push; ativa o push neste navegador. */
import { NOTIFICATION_TYPE_KEYS, type NotificationType } from "@recpm/shared";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageHeader } from "../../components/page-header";
import { api, unwrapVoid } from "../../lib/api";
import { type NotificationPref, notificationPrefsQuery } from "../../lib/comms";
import { errorMessage } from "../../lib/errors";
import { currentPushSubscription, disablePush, enablePush, pushSupported } from "../../lib/push";

export const Route = createFileRoute("/_app/conta/notificacoes")({ component: NotificationSettings });

const CHANNELS = ["inApp", "email", "push"] as const;

function NotificationSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery(notificationPrefsQuery);
  const [prefs, setPrefs] = useState<NotificationPref[] | null>(null);
  useEffect(() => {
    if (q.data && !prefs) setPrefs(q.data.data);
  }, [q.data, prefs]);
  const save = useMutation({
    mutationFn: (preferences: NotificationPref[]) =>
      unwrapVoid(api.notifications.preferences.$put({ json: { preferences: preferences as never } })),
    onSuccess: () => {
      toast.success(t("notifications.saved"));
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
    onError: (e) => toast.error(errorMessage(t, e)),
  });
  const toggle = (type: string, ch: (typeof CHANNELS)[number]) =>
    setPrefs((p) => p?.map((x) => (x.type === type ? { ...x, [ch]: !x[ch] } : x)) ?? p);

  return (
    <>
      <PageHeader
        title={t("notifications.settingsTitle")}
        description={t("notifications.settingsSubtitle")}
      />
      <div className="grid max-w-3xl gap-6">
        <PushCard available={q.data?.pushAvailable ?? false} />
        <Card>
          <CardHeader>
            <CardTitle>{t("notifications.byType")}</CardTitle>
            <CardDescription>{t("notifications.byTypeHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            {!prefs ? (
              <Skeleton className="h-80" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-2 font-medium">{t("notifications.type")}</th>
                      {CHANNELS.map((ch) => (
                        <th key={ch} className="w-16 px-1 py-2 text-center font-medium">
                          {t(`notifications.channels.${ch}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {NOTIFICATION_TYPE_KEYS.map((type: NotificationType) => {
                      const p = prefs.find((x) => x.type === type);
                      if (!p) return null;
                      return (
                        <tr key={type} className="border-b last:border-0">
                          <td className="py-2 pr-2">{t(`notifications.types.${type}`)}</td>
                          {CHANNELS.map((ch) => (
                            <td key={ch} className="px-1 py-2 text-center">
                              <input
                                type="checkbox"
                                className="size-4 accent-[var(--primary)]"
                                checked={p[ch]}
                                aria-label={`${t(`notifications.types.${type}`)} · ${t(`notifications.channels.${ch}`)}`}
                                onChange={() => toggle(type, ch)}
                              />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <Button disabled={!prefs || save.isPending} onClick={() => prefs && save.mutate(prefs)}>
                {t("common.save")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function PushCard({ available }: { available: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"loading" | "on" | "off">("loading");
  const [busy, setBusy] = useState(false);
  const supported = pushSupported();
  useEffect(() => {
    void currentPushSubscription().then((s) => setState(s ? "on" : "off"));
  }, []);
  const on = async () => {
    setBusy(true);
    try {
      const r = await enablePush();
      if (r === "ok") setState("on");
      else toast.error(t(r === "denied" ? "notifications.pushDenied" : "notifications.pushUnavailable"));
    } catch (e) {
      toast.error(errorMessage(t, e));
    } finally {
      setBusy(false);
    }
  };
  const off = async () => {
    setBusy(true);
    try {
      await disablePush();
      setState("off");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4" /> {t("notifications.pushTitle")}
        </CardTitle>
        <CardDescription>{t("notifications.pushHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3">
        {!supported || !available ? (
          <p className="text-sm text-muted-foreground">
            {t(!supported ? "notifications.pushNotSupported" : "notifications.pushUnavailable")}
          </p>
        ) : state === "on" ? (
          <>
            <span className="text-sm text-success">{t("notifications.pushOn")}</span>
            <Button variant="outline" disabled={busy} onClick={off}>
              {t("notifications.pushDisable")}
            </Button>
          </>
        ) : (
          <Button disabled={busy || state === "loading"} onClick={on}>
            {t("notifications.pushEnable")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
