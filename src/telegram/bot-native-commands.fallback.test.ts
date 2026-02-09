import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchReplyWithBufferedBlockDispatcher = vi.hoisted(() => vi.fn());
const deliverReplies = vi.hoisted(() => vi.fn());
const listSkillCommandsForAgents = vi.hoisted(() => vi.fn(() => []));
const readChannelAllowFromStore = vi.hoisted(() => vi.fn().mockResolvedValue([]));

const listNativeCommandSpecsForConfig = vi.hoisted(() =>
  vi.fn(() => [{ name: "ask", description: "Ask" }]),
);
const listNativeCommandSpecs = vi.hoisted(() => vi.fn(() => [{ name: "ask", description: "Ask" }]));
const findCommandByNativeName = vi.hoisted(() => vi.fn(() => undefined));

vi.mock("../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher,
}));

vi.mock("./bot/delivery.js", () => ({
  deliverReplies,
}));

vi.mock("../auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents,
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore,
}));

vi.mock("../auto-reply/commands-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/commands-registry.js")>();
  return {
    ...actual,
    listNativeCommandSpecsForConfig,
    listNativeCommandSpecs,
    findCommandByNativeName,
  };
});

import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

describe("registerTelegramNativeCommands empty-response fallback", () => {
  beforeEach(() => {
    dispatchReplyWithBufferedBlockDispatcher.mockReset();
    deliverReplies.mockReset();
    listSkillCommandsForAgents.mockReset();
    readChannelAllowFromStore.mockReset();
    readChannelAllowFromStore.mockResolvedValue([]);
  });

  it("sends a fallback when a native command queues an empty final reply", async () => {
    const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        deleteMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      command: vi.fn((name: string, fn: (ctx: unknown) => Promise<void>) => {
        handlers.set(name, fn);
      }),
    };

    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "" }, { kind: "final", reason: "empty" });
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });
    deliverReplies.mockResolvedValueOnce({ delivered: true }); // fallback

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg: {
        agents: { list: [{ id: "default", default: true }] },
      },
      runtime: {} as RuntimeEnv,
      accountId: "default",
      telegramCfg: {} as TelegramAccountConfig,
      allowFrom: undefined,
      groupAllowFrom: undefined,
      replyToMode: "off",
      textLimit: 4096,
      useAccessGroups: false,
      nativeEnabled: true,
      nativeSkillsEnabled: true,
      nativeDisabledExplicit: false,
      resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
      resolveTelegramGroupConfig: () => ({ groupConfig: undefined, topicConfig: undefined }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    const handler = handlers.get("ask");
    expect(handler).toBeTypeOf("function");

    await handler?.({
      message: {
        chat: { id: 123, type: "private" },
        message_id: 456,
        from: { id: 1, username: "u", is_bot: false },
        date: Math.floor(Date.now() / 1000),
      },
      match: "hello",
      update: {},
    });

    expect(deliverReplies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        replies: [{ text: "No response generated. Please try again." }],
      }),
    );
  });
});
