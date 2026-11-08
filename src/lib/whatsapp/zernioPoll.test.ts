import { describe, expect, test } from "bun:test";
import { chatsToRead, polledMessageEvent } from "./zernioPoll";
import type { ProviderChatRecord } from "./providers";

const chat = (id: string, lastMessageAt: string | null, extra: Partial<ProviderChatRecord> = {}): ProviderChatRecord => ({
  unipileChatId: id,
  providerId: "5511987654321@s.whatsapp.net",
  phone: "+5511987654321",
  name: "Ana",
  isGroup: false,
  lastMessageAt: lastMessageAt ? new Date(lastMessageAt) : null,
  unreadCount: 0,
  ...extra,
});

describe("chatsToRead", () => {
  test("reads new chats and chats updated since the last stored message", () => {
    const stored = new Map<string, Date | null>([
      ["seen", new Date("2026-11-08T10:00:00Z")],
      ["updated", new Date("2026-11-08T10:00:00Z")],
    ]);
    const result = chatsToRead([
      chat("new", "2026-11-08T09:00:00Z"),
      chat("seen", "2026-11-08T10:00:00Z"),
      chat("updated", "2026-11-08T10:05:00Z"),
    ], stored);
    expect(result.map((c) => c.unipileChatId)).toEqual(["new", "updated"]);
  });

  test("skips groups and chats without a phone", () => {
    expect(chatsToRead([chat("g", null, { isGroup: true }), chat("p", null, { phone: null })], new Map())).toEqual([]);
  });
});

describe("polledMessageEvent", () => {
  test("builds the webhook path's event", () => {
    const event = polledMessageEvent("acc1", chat("c1", null), {
      unipileMessageId: "m1",
      isSender: false,
      body: "Oi",
      attachments: [],
      sentAt: new Date("2026-11-08T10:00:00Z"),
      deliveredAt: null,
      readAt: null,
    });
    expect(event).toMatchObject({ kind: "message", unipileAccountId: "acc1", unipileChatId: "c1", unipileMessageId: "m1", counterpartyPhone: "+5511987654321", isSender: false });
  });
});
