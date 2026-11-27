import { EMPLOYMENT_TYPES, type MemberProfileInput, SENIORITY_LEVELS } from "@recpm/shared";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
} from "@recpm/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, unwrap } from "../lib/api";
import { catalogQuery } from "../lib/catalogs";
import { errorMessage } from "../lib/errors";
import type { Member } from "../lib/queries";
import { DEFAULT_WEEK, type Week, WeekHoursEditor } from "./week-hours";

/** Edição do perfil de trabalho (§3): papel, cargo, setor, custo/hora, contatos, datas e horário. */
export function MemberDialog({
  member,
  isSelf,
  onClose,
}: {
  member: Member;
  isSelf: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const sectors = useQuery(catalogQuery("sectors"));
  const roles = useQuery(catalogQuery("task-roles"));
  const portal = member.role === "cliente";
  const [f, setF] = useState({
    role: member.role,
    jobTitle: member.jobTitle ?? "",
    level: member.level ?? "",
    employmentType: member.employmentType ?? "",
    sectorId: member.sectorId ?? "",
    defaultTaskRoleId: member.defaultTaskRoleId ?? "",
    isAccountManager: member.isAccountManager,
    hourlyCost:
      member.hourlyCostCents === null ? "" : (member.hourlyCostCents / 100).toFixed(2).replace(".", ","),
    phone: member.phone ?? "",
    whatsapp: member.whatsapp ?? "",
    birthday: member.birthday ?? "",
    hireDate: member.hireDate ?? "",
    timezone: member.timezone ?? "",
  });
  const [ownHours, setOwnHours] = useState(!!member.businessHours);
  const [week, setWeek] = useState<Week>(() => ({ ...DEFAULT_WEEK, ...(member.businessHours?.days ?? {}) }));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((s) => ({
      ...s,
      [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value,
    }));
  const nul = (v: string) => v.trim() || null;

  const save = useMutation({
    mutationFn: () => {
      const json: MemberProfileInput = portal
        ? { phone: nul(f.phone), whatsapp: nul(f.whatsapp) }
        : {
            ...(isSelf ? {} : { role: f.role as "admin" | "gestor" | "funcionario" }),
            jobTitle: nul(f.jobTitle),
            level: (f.level || null) as MemberProfileInput["level"],
            employmentType: (f.employmentType || null) as MemberProfileInput["employmentType"],
            sectorId: f.sectorId || null,
            defaultTaskRoleId: f.defaultTaskRoleId || null,
            isAccountManager: f.isAccountManager,
            hourlyCostCents: f.hourlyCost.trim()
              ? Math.round(Number(f.hourlyCost.replace(",", ".")) * 100)
              : null,
            phone: nul(f.phone),
            whatsapp: nul(f.whatsapp),
            birthday: f.birthday || null,
            hireDate: f.hireDate || null,
            timezone: nul(f.timezone),
            businessHours: ownHours ? { days: week as never } : null,
          };
      return unwrap(api.members[":id"].$patch({ param: { id: member.id }, json: json as never }));
    },
    onSuccess: async () => {
      toast.success(t("members.saved"));
      onClose();
      await qc.invalidateQueries({ queryKey: ["members"] });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t("common.cancel")} className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{member.name}</DialogTitle>
          <DialogDescription>{member.email}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          {save.error ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(t, save.error)}
            </p>
          ) : null}
          {!portal && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="m-role" label={t("members.role")} hint={isSelf ? t("members.ownRole") : undefined}>
                <Select id="m-role" value={f.role} onChange={set("role")} disabled={isSelf}>
                  {(["admin", "gestor", "funcionario"] as const).map((r) => (
                    <option key={r} value={r}>
                      {t(`roles.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="m-title" label={t("members.fields.jobTitle")}>
                <Input id="m-title" value={f.jobTitle} onChange={set("jobTitle")} />
              </Field>
              <Field id="m-sector" label={t("members.fields.sector")}>
                <Select id="m-sector" value={f.sectorId} onChange={set("sectorId")}>
                  <option value="">—</option>
                  {sectors.data?.data
                    .filter((s) => s.active || s.id === f.sectorId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field id="m-taskrole" label={t("members.fields.defaultTaskRole")}>
                <Select id="m-taskrole" value={f.defaultTaskRoleId} onChange={set("defaultTaskRoleId")}>
                  <option value="">—</option>
                  {roles.data?.data
                    .filter((s) => s.active || s.id === f.defaultTaskRoleId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field id="m-level" label={t("members.fields.level")}>
                <Select id="m-level" value={f.level} onChange={set("level")}>
                  <option value="">—</option>
                  {SENIORITY_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {t(`members.levels.${l}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="m-emp" label={t("members.fields.employmentType")}>
                <Select id="m-emp" value={f.employmentType} onChange={set("employmentType")}>
                  <option value="">—</option>
                  {EMPLOYMENT_TYPES.map((l) => (
                    <option key={l} value={l}>
                      {t(`members.employment.${l}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                id="m-cost"
                label={t("members.fields.hourlyCost")}
                hint={t("members.fields.hourlyCostHint")}
              >
                <Input id="m-cost" inputMode="decimal" value={f.hourlyCost} onChange={set("hourlyCost")} />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={f.isAccountManager} onChange={set("isAccountManager")} />
                {t("members.fields.isAccountManager")}
              </label>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="m-phone" label={t("members.fields.phone")}>
              <Input id="m-phone" type="tel" value={f.phone} onChange={set("phone")} />
            </Field>
            <Field id="m-wa" label="WhatsApp">
              <Input id="m-wa" type="tel" value={f.whatsapp} onChange={set("whatsapp")} />
            </Field>
            {!portal && (
              <>
                <Field id="m-bday" label={t("members.fields.birthday")}>
                  <Input id="m-bday" type="date" value={f.birthday} onChange={set("birthday")} />
                </Field>
                <Field id="m-hire" label={t("members.fields.hireDate")}>
                  <Input id="m-hire" type="date" value={f.hireDate} onChange={set("hireDate")} />
                </Field>
                <Field id="m-tz" label={t("members.fields.timezone")} hint={t("members.fields.timezoneHint")}>
                  <Input
                    id="m-tz"
                    placeholder="America/Sao_Paulo"
                    value={f.timezone}
                    onChange={set("timezone")}
                  />
                </Field>
              </>
            )}
          </div>
          {!portal && (
            <fieldset className="grid gap-3 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{t("members.hours.title")}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={ownHours} onChange={(e) => setOwnHours(e.target.checked)} />
                {t("members.hours.own")}
              </label>
              {!ownHours ? (
                <p className="text-xs text-muted-foreground">{t("members.hours.inherit")}</p>
              ) : (
                <WeekHoursEditor value={week} onChange={setWeek} />
              )}
            </fieldset>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
