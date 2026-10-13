import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonchoHandles } from "../extensions/client.ts";
import {
  buildMemoryText,
  buildKeyFactsText,
  buildProjectSummaryText,
  buildUserProfileText,
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
  it("formats peer card, user profile, and project summary for prompt injection", () => {
    const memoryText = buildMemoryText({
      peerCard: ["Uses pnpm.", "Prefers minimal changes."],
      peerRepresentation: "Prefers pnpm.",
      summary: { content: "Working on the Honcho extension." },
      messages: ["not part of automatic injection"],
    });

    expect(memoryText).toBe(
      "[Persistent memory]\nKey facts:\n• Uses pnpm.\n• Prefers minimal changes.\n\nUser profile:\nPrefers pnpm.\n\nProject summary:\nWorking on the Honcho extension.",
    );
  });

  it("ignores messages and absent or empty selected fields", () => {
    expect(
      buildMemoryText({
        peerCard: ["", "   ", null],
        peerRepresentation: " \n ",
        summary: { content: "" },
        messages: ["ignored"],
      }),
    ).toBeNull();
  });
});

describe("split memory sections", () => {
  it("builds separate text blocks for key facts, user profile, and project summary", () => {
    expect(buildKeyFactsText(["Uses pnpm.", "Keeps changes small."])).toBe(
      "[Persistent memory]\nKey facts:\n• Uses pnpm.\n• Keeps changes small.",
    );
    expect(buildUserProfileText("Prefers pnpm.")).toBe(
      "[Persistent memory]\nUser profile:\nPrefers pnpm.",
    );
    expect(buildProjectSummaryText("Working on the Honcho extension.")).toBe(
      "[Persistent memory]\nProject summary:\nWorking on the Honcho extension.",
    );
  });

  it("returns null for empty section values", () => {
    expect(buildKeyFactsText([])).toBeNull();
    expect(buildUserProfileText(null)).toBeNull();
    expect(buildProjectSummaryText("")).toBeNull();
  });
});

const makeHandles = (context: ReturnType<typeof vi.fn>, addMessages = vi.fn()): HonchoHandles =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Narrow SDK fixture for cache/write behavior.
  ({
    session: { context, addMessages },
    userPeer: { id: "owner", message: (text: string) => ({ peer: "owner", text }) },
    aiPeer: { id: "agent-main", message: (text: string) => ({ peer: "agent-main", text }) },
    config: { contextTokens: 1200, maxMessageLength: 8000 },
  }) as unknown as HonchoHandles;

describe("refreshMemoryCache", () => {
  it("requests directional session context and caches every accepted field exactly once", async () => {
    const context = vi.fn().mockResolvedValue({
      peerCard: [" fact one ", "fact two"],
      peerRepresentation: " profile ",
      summary: { content: " summary " },
      messages: ["ignored"],
    });
    const handles = makeHandles(context);

    await refreshMemoryCache(handles);

    expect(context).toHaveBeenCalledOnce();
    expect(context).toHaveBeenCalledWith({
      summary: true,
      peerPerspective: handles.aiPeer,
      peerTarget: handles.userPeer,
      tokens: 1200,
    });
    expect(getCachedMemory()).toBe(
      "[Persistent memory]\nKey facts:\n• fact one\n• fact two\n\nUser profile:\nprofile\n\nProject summary:\nsummary",
    );
  });

  it("replaces the cache on a successful refresh and preserves stale memory on failure", async () => {
    const first = makeHandles(vi.fn().mockResolvedValue({ peerCard: ["old fact"] }));
    await refreshMemoryCache(first);
    expect(getCachedMemory()).toContain("old fact");

    const failed = makeHandles(vi.fn().mockRejectedValue(new Error("offline")));
    await refreshMemoryCache(failed);
    expect(getCachedMemory()).toBe("[Persistent memory]\nKey facts:\n• old fact");

    const next = makeHandles(vi.fn().mockResolvedValue({ peerCard: ["new fact"] }));
    await refreshMemoryCache(next);
    expect(getCachedMemory()).toBe("[Persistent memory]\nKey facts:\n• new fact");
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
    await refreshMemoryCache(primed);

    const failed = makeHandles(vi.fn(), vi.fn().mockRejectedValue(new Error("write failed")));
    await expect(
      saveMessages(failed, [{ role: "user", content: "question" }]),
    ).resolves.toBeUndefined();
    expect(getCachedMemory()).toContain("preserved");
  });
});
