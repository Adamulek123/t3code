import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runPastedPullRequestLookup } from "./pastedPullRequestLookup";

afterEach(() => vi.useRealTimers());

describe("runPastedPullRequestLookup", () => {
  it("upgrades a successful lookup and ignores an obsolete completion", async () => {
    const onSuccess = vi.fn();
    const onFailure = vi.fn();
    await runPastedPullRequestLookup({
      read: async () => ({ _tag: "Success", value: { number: 7 } }),
      isStale: () => false,
      onSuccess,
      onFailure,
    });
    expect(onSuccess).toHaveBeenCalledWith({ number: 7 });
    expect(onFailure).not.toHaveBeenCalled();

    onSuccess.mockClear();
    await runPastedPullRequestLookup({
      read: async () => ({ _tag: "Success", value: { number: 7 } }),
      isStale: () => true,
      onSuccess,
      onFailure,
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("releases a lookup that never settles through the failure path", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    const lookup = runPastedPullRequestLookup({
      read: () => new Promise<{ _tag: "Failure" }>(() => undefined),
      isStale: () => false,
      onSuccess: vi.fn(),
      onFailure,
      timeoutMs: 10,
    });
    await vi.advanceTimersByTimeAsync(10);
    await lookup;
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
