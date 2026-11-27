import { describe, expect, it } from "vitest";
import { nextOccurrence, rankBetween } from "../src";

const TZ = "America/Sao_Paulo"; // UTC-3, sem horário de verão
const at = (iso: string) => new Date(iso);

describe("nextOccurrence", () => {
  it("diária: mesmo dia se o horário ainda não passou, senão amanhã", () => {
    expect(nextOccurrence("diaria", { at: "09:00" }, at("2026-03-10T11:00:00Z"), TZ)?.toISOString()).toBe(
      "2026-03-10T12:00:00.000Z",
    );
    expect(nextOccurrence("diaria", { at: "09:00" }, at("2026-03-10T12:00:00Z"), TZ)?.toISOString()).toBe(
      "2026-03-11T12:00:00.000Z",
    );
  });

  it("diária a cada 3 dias conta a partir da âncora", () => {
    const anchor = at("2026-03-10T10:00:00Z");
    const r = nextOccurrence("diaria", { interval: 3, at: "08:00" }, at("2026-03-11T15:00:00Z"), TZ, anchor);
    expect(r?.toISOString()).toBe("2026-03-13T11:00:00.000Z");
  });

  it("semanal em segunda e quinta", () => {
    // 2026-03-10 é terça
    const r = nextOccurrence("semanal", { weekdays: [1, 4], at: "08:00" }, at("2026-03-10T15:00:00Z"), TZ);
    expect(r?.toISOString()).toBe("2026-03-12T11:00:00.000Z");
  });

  it("mensal no dia 31 usa o último dia de meses curtos", () => {
    const r = nextOccurrence("mensal", { dayOfMonth: 31, at: "08:00" }, at("2026-02-01T15:00:00Z"), TZ);
    expect(r?.toISOString()).toBe("2026-02-28T11:00:00.000Z");
  });

  it("mensal a cada 2 meses", () => {
    const anchor = at("2026-01-05T12:00:00Z");
    const r = nextOccurrence(
      "mensal",
      { interval: 2, dayOfMonth: 5 },
      at("2026-01-06T00:00:00Z"),
      TZ,
      anchor,
    );
    expect(r?.toISOString()).toBe("2026-03-05T11:00:00.000Z");
  });

  it("until encerra a série", () => {
    expect(nextOccurrence("diaria", { until: "2026-03-10" }, at("2026-03-10T15:00:00Z"), TZ)).toBeNull();
  });
});

describe("rankBetween", () => {
  it("gera chaves ordenáveis", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const mid = rankBetween(a, b);
    expect(a < mid && mid < b).toBe(true);
  });
});
