import { describe, expect, test } from "bun:test";
import { getWhatsappProvider, isWhatsappProviderKey, WHATSAPP_PROVIDERS } from "./index";
import { unipileWhatsappProvider } from "./unipile";

describe("WhatsApp provider registry", () => {
  test("unipile is a provider; a calling station is not", () => {
    expect(isWhatsappProviderKey("unipile")).toBe(true);
    expect(isWhatsappProviderKey("station")).toBe(false);
    expect(isWhatsappProviderKey("toString")).toBe(false);
  });

  test("getWhatsappProvider returns the account's provider", () => {
    expect(getWhatsappProvider("unipile")).toBe(unipileWhatsappProvider);
    expect(WHATSAPP_PROVIDERS).toContain(unipileWhatsappProvider);
  });

  test("a station's number never reaches a provider API", () => {
    expect(() => getWhatsappProvider("station")).toThrow();
  });
});

describe("Unipile provider errors", () => {
  test("reads the status and the reason Unipile gave", () => {
    const error = { body: { status: 422, detail: "Recipient not on WhatsApp" } };
    expect(unipileWhatsappProvider.errorStatus(error)).toBe(422);
    expect(unipileWhatsappProvider.errorReason(error)).toBe("Recipient not on WhatsApp");
  });

  test("falls back to the title, then to nothing", () => {
    expect(unipileWhatsappProvider.errorReason({ body: { title: "Forbidden" } })).toBe("Forbidden");
    expect(unipileWhatsappProvider.errorReason(new Error("boom"))).toBeNull();
  });
});
