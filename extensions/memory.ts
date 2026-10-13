import type { HonchoHandles } from "./client.js";

// --- Cached memory text ---
export const CACHE_TTL_MS = 10 * 60 * 1000;
export const MAX_CONCLUSIONS = 8;
const REPRESENTATION_LINE_LIMIT = 5;

interface CachedPeerContext {
  representation?: string | null;
  peerCard?: (string | null | undefined)[] | null;
}

interface MemoryCacheEntry {
  at: number;
  text: string | null;
}

const memoryCache = new Map<string, MemoryCacheEntry>();
let activeMemoryKey: string | null = null;

export const buildMemoryText = (
  context: CachedPeerContext | null | undefined,
  peerName: string,
): string | null => {
  if (!context) {
    return null;
  }

  const parts: string[] = [];
  const { representation } = context;
  if (typeof representation === "string" && representation.trim()) {
    const lines = representation
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .slice(0, REPRESENTATION_LINE_LIMIT)
      .map((line) => line.replace(/^[-*]\s*/, "").replace(/^\[.*?\]\s*/, ""));
    if (lines.length > 0) {
      parts.push(lines.map((line) => `- ${line}`).join("\n"));
    }
  }

  if (context.peerCard?.length) {
    parts.push(`Profile: ${context.peerCard.join("; ")}`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `<honcho-memory peer="${peerName}">\n${parts.join("\n")}\n</honcho-memory>`;
};

const getMemoryKey = (handles: HonchoHandles, conversationId: string): string =>
  JSON.stringify([
    handles.config.baseURL ?? null,
    handles.config.workspaceId,
    handles.userPeer.id,
    handles.aiPeer.id,
    handles.sessionKey,
    conversationId,
  ]);

export const getCachedMemory = (): string | null =>
  activeMemoryKey ? (memoryCache.get(activeMemoryKey)?.text ?? null) : null;

export const deactivateCachedMemory = (): void => {
  activeMemoryKey = null;
};

export const clearCachedMemory = (): void => {
  memoryCache.clear();
  deactivateCachedMemory();
};

// --- Async save queue ---
let pendingSave: Promise<void> = Promise.resolve();

const enqueue = (fn: () => Promise<void>): Promise<void> => {
  pendingSave = pendingSave.then(fn, () => fn());
  return pendingSave;
};

export const flushPending = (): Promise<void> => pendingSave;

// --- Memory fetch ---

/**
 * Activate the identity-scoped cache, reusing it for ten minutes or refreshing
 * it from the user peer. A failed refresh preserves same-identity stale memory.
 */
export const refreshMemoryCache = async (
  handles: HonchoHandles,
  conversationId: string,
): Promise<void> => {
  const key = getMemoryKey(handles, conversationId);
  activeMemoryKey = key;
  const cached = memoryCache.get(key);
  if (cached && Date.now() - cached.at <= CACHE_TTL_MS) {
    return;
  }

  try {
    const context = await handles.userPeer.context({
      maxConclusions: MAX_CONCLUSIONS,
      includeMostFrequent: true,
    });

    memoryCache.set(key, {
      at: Date.now(),
      text: buildMemoryText(context, handles.userPeer.id),
    });
  } catch {
    // Keep same-identity stale cache on failure rather than clearing it.
  }
};

// --- Message extraction helpers ---

interface ContentBlock {
  type?: string;
  text?: string;
}

const isTextBlock = (block: ContentBlock): block is ContentBlock & { text: string } =>
  block.type === "text" && typeof block.text === "string";

const extractText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return (content as ContentBlock[])
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("\n")
    .trim();
};

interface ConversationAgentMessage {
  role?: string;
  content?: unknown;
}

/**
 * Extract user/assistant text pairs from agent_end messages.
 * Skips tool results, images, and oversized blobs.
 */
export const extractConversationalPairs = (
  messages: ConversationAgentMessage[],
  maxMessageLength: number,
): { role: "user" | "assistant"; text: string }[] => {
  const pairs: { role: "user" | "assistant"; text: string }[] = [];

  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") {
      continue;
    }

    const text = extractText(msg.content);
    if (!text || text.length > maxMessageLength) {
      continue;
    }

    pairs.push({ role: msg.role, text });
  }

  return pairs;
};

// --- Message save pipeline ---

/**
 * Save conversational messages to Honcho.
 * Memory is only fetched at session start — mid-session context comes
 * from the conversation history itself.
 * Enqueued so saves happen in order without racing.
 */
export const saveMessages = (
  handles: HonchoHandles,
  messages: ConversationAgentMessage[],
): Promise<void> => {
  const pairs = extractConversationalPairs(messages, handles.config.maxMessageLength);
  if (pairs.length === 0) {
    return Promise.resolve();
  }

  return enqueue(async () => {
    try {
      const honchoMessages = pairs.map((pair) => {
        if (pair.role === "user") {
          return handles.userPeer.message(pair.text);
        }
        return handles.aiPeer.message(pair.text);
      });
      await handles.session.addMessages(honchoMessages);
    } catch {
      // Non-fatal: message save failed, will retry on next turn
    }
  });
};
