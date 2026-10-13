import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HonchoHandles } from "../extensions/client.ts";
import {
  CACHE_TTL_MS,
  buildMemoryText,
  clearCachedMemory,
  extractConversationalPairs,
  flushPending,
  getCachedMemory,
  refreshMemoryCache,
  saveMessages,
} from "../extensions/memory.ts";

beforeEach(async () => {
  await flushPending();
  clearCachedMemory();
});

describe("extractConversationalPairs", () => {
  it("keeps user and assistant text messages in order", () => {
    const pairs = extractConversationalPairs(
      [
        { role: "system", content: "ignore me" },
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Hi" },
            { type: "image", text: "ignored" },
            { type: "text", text: "How can I help?" },
          ],
        },
        { role: "tool", content: "ignore me too" },
      ],
      8000,
    );

    expect(pairs).toEqual([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi\nHow can I help?" },
    ]);
  });

  it("skips empty and oversized messages", () => {
    const pairs = extractConversationalPairs(
      [
        { role: "user", content: [] },
        { role: "assistant", content: "x".repeat(8001) },
        { role: "assistant", content: "kept" },
      ],
      8000,
    );

    expect(pairs).toEqual([{ role: "assistant", text: "kept" }]);
  });
});

describe("buildMemoryText", () => {
  it("matches the Codex representation and peer-card rendering contract", () => {
    const context = {
      representation: [
        "# heading",
        " [2026-10-13] first ",
        "* second",
        "- third",
        "fourth",
        "fifth",
        "sixth is capped",
      ].join("\n"),
      peerCard: ["Uses pnpm.", "Prefers minimal changes."],
      summary: { content: "Working on the Honcho extension." },
      messages: ["not part of automatic injection"],
    };
    const memoryText = buildMemoryText(context, "owner");

    expect(memoryText).toBe(
      '<honcho-memory peer="owner">\n- first\n- second\n- third\n- fourth\n- fifth\nProfile: Uses pnpm.; Prefers minimal changes.\n</honcho-memory>',
    );
  });

  it("returns null when both selected fields are absent or empty", () => {
    expect(buildMemoryText({ peerCard: [], representation: " \n# heading " }, "owner")).toBeNull();
    expect(buildMemoryText(null, "owner")).toBeNull();
  });
});

interface FixtureIdentity {
  baseURL?: string;
  workspaceId?: string;
  userPeerId?: string;
  aiPeerId?: string;
  sessionKey?: string;
}

const makeHandles = (
  context: ReturnType<typeof vi.fn>,
  addMessages = vi.fn(),
  identity: FixtureIdentity = {},
): HonchoHandles =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Narrow SDK fixture for cache/write behavior.
  ({
    session: { addMessages },
    sessionKey: identity.sessionKey ?? "repo:fixture",
    userPeer: {
      id: identity.userPeerId ?? "owner",
      context,
      message: (text: string) => ({ peer: "owner", text }),
    },
    aiPeer: {
      id: identity.aiPeerId ?? "agent-main",
      message: (text: string) => ({ peer: "agent-main", text }),
    },
    config: {
      baseURL: identity.baseURL,
      workspaceId: identity.workspaceId ?? "fixture",
      contextTokens: 1200,
      maxMessageLength: 8000,
    },
  }) as unknown as HonchoHandles;

describe("refreshMemoryCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests user-peer context with the exact Codex options and selected fields", async () => {
    const context = vi.fn().mockResolvedValue({
      representation: "# owner\n- fact one\n- fact two",
      peerCard: ["profile one", "profile two"],
      summary: { content: " summary " },
      messages: ["ignored"],
    });
    const handles = makeHandles(context);

    await refreshMemoryCache(handles, "conversation-a");

    expect(context).toHaveBeenCalledOnce();
    expect(context).toHaveBeenCalledWith({
      maxConclusions: 8,
      includeMostFrequent: true,
    });
    expect(getCachedMemory()).toBe(
      '<honcho-memory peer="owner">\n- fact one\n- fact two\nProfile: profile one; profile two\n</honcho-memory>',
    );
    expect(getCachedMemory()).not.toContain("summary");
    expect(getCachedMemory()).not.toContain("ignored");
  });

  it("reuses the same identity through the TTL boundary and refreshes only after it", async () => {
    const context = vi
      .fn()
      .mockResolvedValueOnce({ peerCard: ["old fact"] })
      .mockResolvedValueOnce({ peerCard: ["new fact"] });
    const handles = makeHandles(context);
    await refreshMemoryCache(handles, "conversation-a");
    expect(getCachedMemory()).toContain("old fact");

    vi.setSystemTime(Date.now() + CACHE_TTL_MS);
    await refreshMemoryCache(handles, "conversation-a");
    expect(context).toHaveBeenCalledOnce();
    expect(getCachedMemory()).toContain("old fact");

    vi.setSystemTime(Date.now() + 1);
    await refreshMemoryCache(handles, "conversation-a");
    expect(context).toHaveBeenCalledTimes(2);
    expect(getCachedMemory()).toContain("new fact");
  });

  it("preserves same-identity stale memory after a failed refresh", async () => {
    const oldContext = vi.fn().mockResolvedValue({ peerCard: ["old fact"] });
    const oldHandles = makeHandles(oldContext);
    await refreshMemoryCache(oldHandles, "conversation-a");

    vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1);
    oldContext.mockRejectedValueOnce(new Error("offline"));
    await refreshMemoryCache(oldHandles, "conversation-a");
    expect(getCachedMemory()).toContain("old fact");
  });

  it.each([
    ["endpoint", { baseURL: "https://other.invalid" }],
    ["workspace", { workspaceId: "other" }],
    ["user peer", { userPeerId: "other" }],
    ["AI peer", { aiPeerId: "other" }],
    ["session", { sessionKey: "repo:other" }],
  ])("never exposes cached memory across a different %s identity", async (_label, identity) => {
    const oldHandles = makeHandles(vi.fn().mockResolvedValue({ peerCard: ["old fact"] }));
    await refreshMemoryCache(oldHandles, "conversation-a");

    const otherContext = vi.fn().mockRejectedValue(new Error("offline"));
    const otherHandles = makeHandles(otherContext, vi.fn(), identity);
    await refreshMemoryCache(otherHandles, "conversation-a");
    expect(getCachedMemory()).toBeNull();
  });

  it("never exposes cached memory across Pi conversations", async () => {
    const context = vi
      .fn()
      .mockResolvedValueOnce({ peerCard: ["old fact"] })
      .mockRejectedValueOnce(new Error("offline"));
    const handles = makeHandles(context);

    await refreshMemoryCache(handles, "conversation-a");
    expect(getCachedMemory()).toContain("old fact");

    await refreshMemoryCache(handles, "conversation-b");
    expect(getCachedMemory()).toBeNull();
  });

  it("caches an empty successful response without repeated reads", async () => {
    const context = vi.fn().mockResolvedValue({ representation: null, peerCard: null });
    const handles = makeHandles(context);

    await refreshMemoryCache(handles, "conversation-a");
    await refreshMemoryCache(handles, "conversation-a");

    expect(context).toHaveBeenCalledOnce();
    expect(getCachedMemory()).toBeNull();
  });
});

describe("saveMessages", () => {
  it("writes only eligible conversation messages without issuing another context read", async () => {
    const context = vi.fn();
    const addMessages = vi.fn().mockResolvedValue(undefined);
    const handles = makeHandles(context, addMessages);

    await saveMessages(handles, [
      { role: "user", content: "question" },
      { role: "tool", content: "ignored" },
      { role: "assistant", content: "answer" },
    ]);

    expect(addMessages).toHaveBeenCalledWith([
      { peer: "owner", text: "question" },
      { peer: "agent-main", text: "answer" },
    ]);
    expect(context).not.toHaveBeenCalled();
  });

  it("keeps SDK write failures non-fatal and does not clear cached memory", async () => {
    const primed = makeHandles(vi.fn().mockResolvedValue({ peerCard: ["preserved"] }));
    await refreshMemoryCache(primed, "conversation-a");

    const failed = makeHandles(vi.fn(), vi.fn().mockRejectedValue(new Error("write failed")));
    await expect(
      saveMessages(failed, [{ role: "user", content: "question" }]),
    ).resolves.toBeUndefined();
    expect(getCachedMemory()).toContain("preserved");
  });
});
