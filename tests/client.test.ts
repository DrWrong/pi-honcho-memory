import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrap, clearHandles, getHandles } from "../extensions/client.ts";

const sdk = vi.hoisted(() => {
  const userPeer = { id: "owner" };
  const aiPeer = { id: "agent-main" };
  const session = { id: "repo_DrWrong_pi-honcho-memory", addPeers: vi.fn() };
  const peer = vi.fn(async (id: string) => (id === "owner" ? userPeer : aiPeer));
  const getSession = vi.fn(async () => session);
  const constructor = vi.fn();

  return { userPeer, aiPeer, session, peer, getSession, constructor };
});

vi.mock("@honcho-ai/sdk", () => ({
  Honcho: class {
    peer = sdk.peer;
    session = sdk.getSession;

    constructor(options: unknown) {
      sdk.constructor(options);
    }
  },
}));

describe("bootstrap", () => {
  beforeEach(() => {
    clearHandles();
    vi.clearAllMocks();
  });

  it("uses configured workspace and peer identities with the derived session", async () => {
    const pi = {
      exec: vi.fn(async () => ({
        code: 0,
        stdout: "git@github.com:DrWrong/pi-honcho-memory.git\n",
      })),
    };
    const config = {
      enabled: true,
      apiKey: "fixture-key",
      baseURL: "https://honcho.invalid/v3",
      workspaceId: "shared-workspace",
      userPeerId: "owner",
      aiPeerId: "agent-main",
      sessionStrategy: "repo" as const,
      contextTokens: 1200,
      maxMessageLength: 8000,
      searchLimit: 8,
      toolPreviewLength: 500,
    };

    // @ts-expect-error Minimal Pi exec fixture.
    const handles = await bootstrap(pi, config, "/tmp/worktree");

    expect(sdk.constructor).toHaveBeenCalledWith({
      apiKey: "fixture-key",
      baseURL: "https://honcho.invalid/v3",
      workspaceId: "shared-workspace",
    });
    expect(sdk.peer.mock.calls).toEqual([["owner"], ["agent-main"]]);
    expect(sdk.getSession).toHaveBeenCalledWith("repo_DrWrong_pi-honcho-memory");
    expect(sdk.session.addPeers).toHaveBeenCalledWith([sdk.userPeer, sdk.aiPeer]);
    expect(handles).toMatchObject({
      userPeer: sdk.userPeer,
      aiPeer: sdk.aiPeer,
      session: sdk.session,
      sessionKey: "repo_DrWrong_pi-honcho-memory",
      config,
    });
    expect(getHandles()).toBe(handles);
  });
});
