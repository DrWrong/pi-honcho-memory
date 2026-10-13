import { beforeEach, describe, expect, it, vi } from "vitest";
import honcho from "../extensions/index.ts";

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(),
  clearHandles: vi.fn(),
  getHandles: vi.fn(),
  registerCommands: vi.fn(),
  registerTools: vi.fn(),
  resolveConfig: vi.fn(),
  deactivateCachedMemory: vi.fn(),
  flushPending: vi.fn(async () => undefined),
  refreshMemoryCache: vi.fn(),
  saveMessages: vi.fn(async () => undefined),
  memoryText: null as string | null,
}));

vi.mock("../extensions/client.ts", () => ({
  bootstrap: mocks.bootstrap,
  clearHandles: mocks.clearHandles,
  getHandles: mocks.getHandles,
}));
vi.mock("../extensions/commands.ts", () => ({ registerCommands: mocks.registerCommands }));
vi.mock("../extensions/config.ts", () => ({ resolveConfig: mocks.resolveConfig }));
vi.mock("../extensions/memory.ts", () => ({
  deactivateCachedMemory: mocks.deactivateCachedMemory,
  flushPending: mocks.flushPending,
  getCachedMemory: () => mocks.memoryText,
  refreshMemoryCache: mocks.refreshMemoryCache,
  saveMessages: mocks.saveMessages,
}));
vi.mock("../extensions/tools.ts", () => ({ registerTools: mocks.registerTools }));

type Handler = (...args: any[]) => any;

const setupExtension = () => {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
  };
  const statuses: string[] = [];
  const ctx = {
    cwd: "/fixture/repo",
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (_id: string, text: string) => statuses.push(text),
    },
  };

  // @ts-expect-error Minimal ExtensionAPI fixture; registration is the behavior under test.
  honcho(pi);
  return { handlers, statuses, ctx };
};

describe("Pi lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memoryText = null;
    mocks.resolveConfig.mockResolvedValue({ enabled: true, apiKey: "fixture-key" });
    mocks.bootstrap.mockResolvedValue({ session: {}, userPeer: {}, aiPeer: {} });
    mocks.refreshMemoryCache.mockImplementation(async () => {
      mocks.memoryText = '<honcho-memory peer="owner">\n- fixture fact\n</honcho-memory>';
    });
    mocks.getHandles.mockReturnValue({ session: {}, userPeer: {}, aiPeer: {} });
  });

  it("loads memory on session start and injects the same cached block once per prompt", async () => {
    const { handlers, ctx } = setupExtension();

    handlers.get("session_start")?.({}, ctx);
    const first = await handlers.get("before_agent_start")?.({ systemPrompt: "base prompt" });
    const second = await handlers.get("before_agent_start")?.({ systemPrompt: "base prompt" });

    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.refreshMemoryCache).toHaveBeenCalledOnce();
    expect(first).toEqual({
      systemPrompt: 'base prompt\n\n<honcho-memory peer="owner">\n- fixture fact\n</honcho-memory>',
    });
    expect(second).toEqual(first);
    expect(first.systemPrompt.match(/fixture fact/g)).toHaveLength(1);
  });

  it("keeps message writes separate from the single session-start refresh", async () => {
    const { handlers, ctx } = setupExtension();
    const messages = [{ role: "user", content: "hello" }];

    handlers.get("session_start")?.({}, ctx);
    await handlers.get("before_agent_start")?.({ systemPrompt: "base" });
    await handlers.get("agent_end")?.({ messages }, ctx);

    expect(mocks.refreshMemoryCache).toHaveBeenCalledOnce();
    expect(mocks.saveMessages).toHaveBeenCalledWith(mocks.getHandles(), messages);
  });

  it("injects nothing and reports offline when SDK bootstrap fails", async () => {
    mocks.bootstrap.mockRejectedValue(new Error("offline"));
    const { handlers, statuses, ctx } = setupExtension();

    handlers.get("session_start")?.({}, ctx);
    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base" });

    expect(result).toBeUndefined();
    expect(mocks.refreshMemoryCache).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe("🧠 Offline");
  });

  it("clears handles and deactivates the view without destroying reusable cache entries", async () => {
    const { handlers, ctx } = setupExtension();

    await handlers.get("session_switch")?.({}, ctx);
    await handlers.get("before_agent_start")?.({ systemPrompt: "base" });

    expect(mocks.flushPending).toHaveBeenCalledOnce();
    expect(mocks.clearHandles).toHaveBeenCalledOnce();
    expect(mocks.deactivateCachedMemory).toHaveBeenCalledOnce();
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.refreshMemoryCache).toHaveBeenCalledOnce();
  });
});
