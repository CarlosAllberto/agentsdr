import { describe, expect, test } from "bun:test";
import { getWhatsappProvider, isWhatsappProviderKey, SYNCED_WHATSAPP_PROVIDERS, WHATSAPP_PROVIDERS } from "./index";
import { unipileWhatsappProvider } from "./unipile";
import { zernioWhatsappProvider } from "./zernio";
import { ZernioApiError } from "@/services/zernio.whatsapp";

describe("WhatsApp provider registry", () => {
  test("unipile is a provider; a calling station is not", () => {
    expect(isWhatsappProviderKey("unipile")).toBe(true);
    expect(isWhatsappProviderKey("station")).toBe(false);
    expect(isWhatsappProviderKey("toString")).toBe(false);
  });

  test("getWhatsappProvider returns the account's provider", () => {
    expect(getWhatsappProvider("unipile")).toBe(unipileWhatsappProvider);
    expect(getWhatsappProvider("zernio")).toBe(zernioWhatsappProvider);
    expect(WHATSAPP_PROVIDERS).toContain(unipileWhatsappProvider);
  });

  test("sync reads Zernio only: WhatsApp moved off Unipile", () => {
    expect(SYNCED_WHATSAPP_PROVIDERS).toEqual([zernioWhatsappProvider]);
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

describe("Zernio provider errors", () => {
  test("turns Meta's template rule into words a rep can act on", () => {
    const error = new ZernioApiError(400, "TEMPLATE_REQUIRED", "Template required");
    expect(zernioWhatsappProvider.errorStatus(error)).toBe(400);
    expect(zernioWhatsappProvider.errorReason(error)).toContain("approved template");
  });

  test("passes other messages through", () => {
    expect(zernioWhatsappProvider.errorReason(new ZernioApiError(422, null, "Bad number"))).toBe("Bad number");
    expect(zernioWhatsappProvider.errorStatus(new Error("boom"))).toBeNull();
  });
});
