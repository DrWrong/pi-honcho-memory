import { describe, expect, it, vi } from "vitest";
import { deriveSessionKey } from "../extensions/session-key.ts";

const makePi = (responses: Record<string, { code: number; stdout: string }>) => ({
  exec: vi.fn(async (_command: string, args: string[]) => {
    const operation = args.slice(2).join(" ");
    return responses[operation] ?? { code: 1, stdout: "" };
  }),
});

describe("deriveSessionKey", () => {
  it("uses the origin owner/repo identity across worktrees", async () => {
    const pi = makePi({
      "remote get-url origin": { code: 0, stdout: "git@github.com:DrWrong/pi-honcho-memory.git\n" },
    });

    // @ts-expect-error Minimal Pi exec fixture.
    await expect(deriveSessionKey(pi, "/tmp/worktree", "repo")).resolves.toBe(
      "repo_DrWrong_pi-honcho-memory",
    );
  });

  it("adds branch identity only for git-branch strategy", async () => {
    const pi = makePi({
      "remote get-url origin": {
        code: 0,
        stdout: "https://github.com/DrWrong/pi-honcho-memory.git\n",
      },
      "rev-parse --abbrev-ref HEAD": { code: 0, stdout: "feature/card parity\n" },
    });

    // @ts-expect-error Minimal Pi exec fixture.
    await expect(deriveSessionKey(pi, "/tmp/worktree", "git-branch")).resolves.toBe(
      "repo_DrWrong_pi-honcho-memory__branch_feature_card_parity",
    );
  });

  it("derives directory identity without any git reads", async () => {
    const pi = makePi({});

    // @ts-expect-error Minimal Pi exec fixture.
    const first = await deriveSessionKey(pi, "/tmp/project", "directory");
    // @ts-expect-error Minimal Pi exec fixture.
    const second = await deriveSessionKey(pi, "/tmp/project", "directory");

    expect(first).toMatch(/^cwd_project_[a-f0-9]{8}$/);
    expect(second).toBe(first);
    expect(pi.exec).not.toHaveBeenCalled();
  });
});
