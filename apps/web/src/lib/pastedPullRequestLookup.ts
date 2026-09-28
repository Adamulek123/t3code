/** Settles a pasted PR lookup even when a disconnected query never completes. */
export async function runPastedPullRequestLookup<T>(input: {
  read: () => Promise<{ _tag: "Success"; value: T } | { _tag: "Failure" }>;
  isStale: () => boolean;
  onSuccess: (value: T) => void;
  onFailure: () => void;
  timeoutMs?: number;
}): Promise<void> {
  let deadline: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([
      input.read(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("PR lookup timed out")),
          input.timeoutMs ?? 30_000,
        );
      }),
    ]);
    if (input.isStale()) return;
    if (result._tag === "Success") input.onSuccess(result.value);
    else input.onFailure();
  } catch {
    if (!input.isStale()) input.onFailure();
  } finally {
    clearTimeout(deadline!);
  }
}
