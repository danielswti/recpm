import { describe, expect, it } from "vitest";
import { businessMsBetween, type WorkCalendar } from "../src/time/business";

const H = 3_600_000;
const cal = (over: Partial<WorkCalendar> = {}): WorkCalendar => ({
  tz: "America/Sao_Paulo",
  schedule: {
    days: Object.fromEntries(
      [1, 2, 3, 4, 5].map((d) => [
        d,
        [
          { start: "09:00", end: "12:00" },
          { start: "13:00", end: "18:00" },
        ],
      ]),
    ),
  },
  daysOff: new Set(),
  yearlyDaysOff: new Set(),
  ...over,
});
// São Paulo = UTC-3 (sem horário de verão desde 2019)
const sp = (s: string) => new Date(`${s}-03:00`);

describe("horas úteis", () => {
  it("conta só dentro do expediente e pula o almoço", () => {
    // quarta 2026-12-02, 08:00 → 14:00 = 9–12 (3h) + 13–14 (1h)
    expect(businessMsBetween(sp("2026-12-02T08:00:00"), sp("2026-12-02T14:00:00"), cal())).toBe(4 * H);
  });

  it("atravessa a noite e o fim de semana", () => {
    // sexta 17:00 → segunda 10:00 = 1h + 1h
    expect(businessMsBetween(sp("2026-12-04T17:00:00"), sp("2026-12-07T10:00:00"), cal())).toBe(2 * H);
  });

  it("feriados e folgas anuais não contam", () => {
    const a = sp("2026-12-24T09:00:00");
    const b = sp("2026-12-25T18:00:00");
    expect(businessMsBetween(a, b, cal())).toBe(16 * H);
    expect(businessMsBetween(a, b, cal({ yearlyDaysOff: new Set(["12-25"]) }))).toBe(8 * H);
    expect(businessMsBetween(a, b, cal({ daysOff: new Set(["2026-12-24", "2026-12-25"]) }))).toBe(0);
  });

  it("usa o fuso da pessoa", () => {
    // 12:00–13:00 UTC = 09:00–10:00 em SP, 12:00–13:00 em Lisboa (almoço não conta)
    const a = new Date("2026-12-02T12:00:00Z");
    const b = new Date("2026-12-02T13:00:00Z");
    expect(businessMsBetween(a, b, cal())).toBe(H);
    expect(businessMsBetween(a, b, cal({ tz: "Europe/Lisbon" }))).toBe(0);
  });

  it("intervalo vazio ou invertido dá zero", () => {
    const a = sp("2026-12-02T10:00:00");
    expect(businessMsBetween(a, a, cal())).toBe(0);
    expect(businessMsBetween(a, sp("2026-12-02T09:00:00"), cal())).toBe(0);
  });
});
