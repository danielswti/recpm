import { describe, expect, it } from "vitest";
import { clientInput, isValidDocument, suggestClientCode } from "./catalogs";

describe("cadastros", () => {
  it("valida CPF e CNPJ pelos dígitos verificadores", () => {
    expect(isValidDocument("529.982.247-25")).toBe(true);
    expect(isValidDocument("529.982.247-24")).toBe(false);
    expect(isValidDocument("11.222.333/0001-81")).toBe(true);
    expect(isValidDocument("11.222.333/0001-80")).toBe(false);
    expect(isValidDocument("111.111.111-11")).toBe(false);
  });
  it("normaliza o cliente: código em maiúsculas, documento só com dígitos, vazios viram null", () => {
    const c = clientInput.parse({ code: "acme", name: "Acme", email: "", document: "11.222.333/0001-81" });
    expect(c).toMatchObject({ code: "ACME", email: null, document: "11222333000181" });
  });
  it("sugere código a partir do nome", () => {
    expect(suggestClientCode("Café Aroma Ltda")).toBe("CAFAROLT");
    expect(suggestClientCode("Nike")).toBe("NIKE");
  });
});
