import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createTelegramDraftStream = vi.hoisted(() => vi.fn());
const dispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() => vi.fn());
const deliverReplies = vi.hoisted(() => vi.fn());

vi.mock("./draft-stream.js", () => ({
  createTelegramDraftStream,
}));

vi.mock("../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher,
}));

vi.mock("./bot/delivery.js", () => ({
  deliverReplies,
}));

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: vi.fn(),
  describeStickerImage: vi.fn(),
}));

import { dispatchTelegramMessage } from "./bot-message-dispatch.js";

describe("dispatchTelegramMessage draft streaming", () => {
  beforeEach(() => {
    createTelegramDraftStream.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    deliverReplies.mockReset();
  });

  it("streams drafts in private threads and forwards thread id", async () => {
    const draftStream = {
      update: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    const resolveBotTopicsEnabled = vi.fn().mockResolvedValue(true);
    const context = {
      ctxPayload: {},
      primaryCtx: { message: { chat: { id: 123, type: "private" } } },
      msg: {
        chat: { id: 123, type: "private" },
        message_id: 456,
        message_thread_id: 777,
      },
      chatId: 123,
      isGroup: false,
      resolvedThreadId: undefined,
      replyThreadId: 777,
      threadSpec: { id: 777, scope: "dm" },
      historyKey: undefined,
      historyLimit: 0,
      groupHistories: new Map(),
      route: { agentId: "default", accountId: "default" },
      skillFilter: undefined,
      sendTyping: vi.fn(),
      sendRecordVoice: vi.fn(),
      ackReactionPromise: null,
      reactionApi: null,
      removeAckAfterReply: false,
    };

    const bot = { api: { sendMessageDraft: vi.fn() } } as unknown as Bot;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("exit");
      },
    };

    await dispatchTelegramMessage({
      context,
      bot,
      cfg: {},
      runtime,
      replyToMode: "first",
      streamMode: "partial",
      textLimit: 4096,
      telegramCfg: {},
      opts: { token: "token" },
      resolveBotTopicsEnabled,
    });

    expect(resolveBotTopicsEnabled).toHaveBeenCalledWith(context.primaryCtx);
    expect(createTelegramDraftStream).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 123,
        thread: { id: 777, scope: "dm" },
      }),
    );
    expect(draftStream.update).toHaveBeenCalledWith("Hello");
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: { id: 777, scope: "dm" },
      }),
    );
  });
});

describe("dispatchTelegramMessage empty final fallback", () => {
  beforeEach(() => {
    createTelegramDraftStream.mockReset();
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    deliverReplies.mockReset();
  });

  it("sends a fallback when a final reply is queued but delivers nothing", async () => {
    createTelegramDraftStream.mockReturnValue(undefined);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "" }, { kind: "final", reason: "empty" });
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    deliverReplies.mockResolvedValueOnce({ delivered: true }); // fallback message

    const resolveBotTopicsEnabled = vi.fn().mockResolvedValue(false);
    const context = {
      ctxPayload: {},
      primaryCtx: { message: { chat: { id: 123, type: "private" } } },
      msg: {
        chat: { id: 123, type: "private" },
        message_id: 456,
      },
      chatId: 123,
      isGroup: false,
      resolvedThreadId: undefined,
      replyThreadId: undefined,
      threadSpec: { id: undefined, scope: "dm" },
      historyKey: undefined,
      historyLimit: 0,
      groupHistories: new Map(),
      route: { agentId: "default", accountId: "default" },
      skillFilter: undefined,
      sendTyping: vi.fn(),
      sendRecordVoice: vi.fn(),
      ackReactionPromise: null,
      reactionApi: null,
      removeAckAfterReply: false,
    };

    const bot = { api: {} } as unknown as Bot;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("exit");
      },
    };

    await dispatchTelegramMessage({
      context,
      bot,
      cfg: {},
      runtime,
      replyToMode: "first",
      streamMode: "off",
      textLimit: 4096,
      telegramCfg: {},
      opts: { token: "token" },
      resolveBotTopicsEnabled,
    });

    // Sends the fallback.
    expect(deliverReplies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replies: [{ text: "No response generated. Please try again." }],
      }),
    );
  });

  it("does not send the empty fallback on heartbeat-only skips", async () => {
    createTelegramDraftStream.mockReturnValue(undefined);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "HEARTBEAT_OK" }, { kind: "final", reason: "heartbeat" });
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    const resolveBotTopicsEnabled = vi.fn().mockResolvedValue(false);
    const context = {
      ctxPayload: {},
      primaryCtx: { message: { chat: { id: 123, type: "private" } } },
      msg: {
        chat: { id: 123, type: "private" },
        message_id: 456,
      },
      chatId: 123,
      isGroup: false,
      resolvedThreadId: undefined,
      replyThreadId: undefined,
      threadSpec: { id: undefined, scope: "dm" },
      historyKey: undefined,
      historyLimit: 0,
      groupHistories: new Map(),
      route: { agentId: "default", accountId: "default" },
      skillFilter: undefined,
      sendTyping: vi.fn(),
      sendRecordVoice: vi.fn(),
      ackReactionPromise: null,
      reactionApi: null,
      removeAckAfterReply: false,
    };

    const bot = { api: {} } as unknown as Bot;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("exit");
      },
    };

    await dispatchTelegramMessage({
      context,
      bot,
      cfg: {},
      runtime,
      replyToMode: "first",
      streamMode: "off",
      textLimit: 4096,
      telegramCfg: {},
      opts: { token: "token" },
      resolveBotTopicsEnabled,
    });

    expect(deliverReplies).not.toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "No response generated. Please try again." }],
      }),
    );
  });

  it("sends an error fallback when delivery throws after queuing a final", async () => {
    createTelegramDraftStream.mockReturnValue(undefined);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onError?.(new Error("send failed"), { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    const resolveBotTopicsEnabled = vi.fn().mockResolvedValue(false);
    const context = {
      ctxPayload: {},
      primaryCtx: { message: { chat: { id: 123, type: "private" } } },
      msg: {
        chat: { id: 123, type: "private" },
        message_id: 456,
      },
      chatId: 123,
      isGroup: false,
      resolvedThreadId: undefined,
      replyThreadId: undefined,
      threadSpec: { id: undefined, scope: "dm" },
      historyKey: undefined,
      historyLimit: 0,
      groupHistories: new Map(),
      route: { agentId: "default", accountId: "default" },
      skillFilter: undefined,
      sendTyping: vi.fn(),
      sendRecordVoice: vi.fn(),
      ackReactionPromise: null,
      reactionApi: null,
      removeAckAfterReply: false,
    };

    const bot = { api: {} } as unknown as Bot;
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: () => {
        throw new Error("exit");
      },
    };

    await dispatchTelegramMessage({
      context,
      bot,
      cfg: {},
      runtime,
      replyToMode: "first",
      streamMode: "off",
      textLimit: 4096,
      telegramCfg: {},
      opts: { token: "token" },
      resolveBotTopicsEnabled,
    });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          { text: "⚠️ Sorry — I hit an error and couldn’t generate a reply. Please try again." },
        ],
      }),
    );
  });
});
