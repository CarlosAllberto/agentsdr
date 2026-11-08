import { describe, expect, test } from "bun:test";
import {
  mapZernioAccount,
  mapZernioConversation,
  mapZernioMessage,
  templateBodyVariableCount,
  zernioAccountStatus,
  zernioPhone,
} from "./zernio.whatsapp";

describe("zernioPhone", () => {
  test("normalizes a formatted number to E.164", () => {
    expect(zernioPhone("+55 11 98765-4321")).toBe("+5511987654321");
    expect(zernioPhone("5511987654321")).toBe("+5511987654321");
  });
  test("rejects what is not a phone", () => {
    expect(zernioPhone("acme")).toBeNull();
    expect(zernioPhone(undefined)).toBeNull();
  });
});

describe("mapZernioAccount", () => {
  test("maps a WhatsApp account", () => {
    expect(mapZernioAccount({ _id: "acc1", platform: "whatsapp", displayName: "Vendas", isActive: true, metadata: { displayPhoneNumber: "+1 555-123-4567" } })).toEqual({
      providerAccountId: "acc1",
      name: "Vendas",
      phone: "+15551234567",
      status: "connected",
    });
  });
  test("skips other platforms", () => {
    expect(mapZernioAccount({ _id: "acc2", platform: "instagram" })).toBeNull();
  });
  test("status follows reconnection and activity", () => {
    expect(zernioAccountStatus({ needsReconnection: true })).toBe("credentials");
    expect(zernioAccountStatus({ isActive: false })).toBe("disconnected");
    expect(zernioAccountStatus({ isActive: true })).toBe("connected");
  });
});

describe("mapZernioConversation", () => {
  test("keeps the jid form so existing chats keep matching", () => {
    const chat = mapZernioConversation({ id: "c1", participantId: "5511987654321", participantName: "Ana", updatedTime: "2026-11-08T10:00:00Z", unreadCount: 2 });
    expect(chat).toEqual({
      unipileChatId: "c1",
      providerId: "5511987654321@s.whatsapp.net",
      phone: "+5511987654321",
      name: "Ana",
      isGroup: false,
      lastMessageAt: new Date("2026-11-08T10:00:00Z"),
      unreadCount: 2,
    });
  });
  test("a group has no phone", () => {
    expect(mapZernioConversation({ id: "g1", participantId: "123456789", isGroup: true })?.phone).toBeNull();
  });
});

describe("mapZernioMessage", () => {
  test("maps direction and attachments", () => {
    const message = mapZernioMessage({ id: "m1", direction: "outgoing", message: "Oi", createdAt: "2026-11-08T10:00:00Z", attachments: [{ id: "a1", type: "image", mimeType: "image/png" }] });
    expect(message?.isSender).toBe(true);
    expect(message?.body).toBe("Oi");
    expect(message?.attachments).toEqual([{ id: "a1", type: "image", name: null, mimeType: "image/png" }]);
  });
  test("drops a message without id or date", () => {
    expect(mapZernioMessage({ id: "m2" })).toBeNull();
    expect(mapZernioMessage({ createdAt: "2026-11-08T10:00:00Z" })).toBeNull();
  });
});

describe("templateBodyVariableCount", () => {
  test("counts distinct body variables", () => {
    expect(templateBodyVariableCount([{ type: "HEADER", text: "{{1}}" }, { type: "BODY", text: "Olá {{1}}, tudo bem? {{1}}" }])).toBe(1);
    expect(templateBodyVariableCount([{ type: "BODY", text: "Olá {{name}}, da {{company}}" }])).toBe(2);
    expect(templateBodyVariableCount([{ type: "BODY", text: "Olá!" }])).toBe(0);
    expect(templateBodyVariableCount(undefined)).toBe(0);
  });
});
