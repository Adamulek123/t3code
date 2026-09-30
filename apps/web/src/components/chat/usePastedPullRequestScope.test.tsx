// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { pastedPullRequestReferenceScope } from "../../lib/composerContextRecords";
import { runPastedPullRequestLookup } from "../../lib/pastedPullRequestLookup";
import { usePastedPullRequestScope } from "./usePastedPullRequestScope";

const base = { environmentId: "env", target: "draft", projectId: "project", repository: "repo" };
const originalScope = pastedPullRequestReferenceScope(base);
let root: Root;
let scopeRef: ReturnType<typeof usePastedPullRequestScope>;

function CommitChild({ settle }: { settle?: (() => void) | undefined }) {
  // Child layout effects run before the parent's scope effect. A promise
  // settled here must still see the new lifetime when its continuation runs.
  useLayoutEffect(() => settle?.(), [settle]);
  return null;
}

function Probe({ scope, settle }: { scope: string; settle?: (() => void) | undefined }) {
  const current = usePastedPullRequestScope(scope);
  useLayoutEffect(() => {
    scopeRef = current;
  }, [current]);
  return <CommitChild settle={settle} />;
}

async function renderScope(scope: string, settle?: () => void) {
  await act(() => root.render(<Probe scope={scope} settle={settle} />));
}

function startLookup() {
  const lifetime = scopeRef.current!;
  type Result = { _tag: "Success"; value: string } | { _tag: "Failure" };
  let resolve!: (result: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((resolveResult, rejectResult) => {
    resolve = resolveResult;
    reject = rejectResult;
  });
  const result = { promise, resolve, reject };
  const draft = { text: "pending" };
  lifetime.inFlight.add(7);
  const done = runPastedPullRequestLookup({
    read: () => result.promise,
    isStale: () => !lifetime.active,
    onSuccess: (title) => {
      draft.text = title;
    },
    onFailure: () => {
      draft.text = "#7";
    },
  }).finally(() => lifetime.inFlight.delete(7));
  return { result, draft, done };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("pasted PR lookup scope lifetime", () => {
  it.each([
    ["environment", pastedPullRequestReferenceScope({ ...base, environmentId: "env2" })],
    ["draft", pastedPullRequestReferenceScope({ ...base, target: "draft2" })],
    ["project", pastedPullRequestReferenceScope({ ...base, projectId: "project2" })],
    ["repository", pastedPullRequestReferenceScope({ ...base, repository: "repo2" })],
    ["unavailable repository", "unavailable"],
  ])("ignores success and failure settling during a %s switch", async (_name, nextScope) => {
    await renderScope(originalScope);
    const success = startLookup();
    const failure = startLookup();
    await renderScope(nextScope, () => {
      success.result.resolve({ _tag: "Success", value: "Old repository PR" });
      failure.result.resolve({ _tag: "Failure" });
    });
    await Promise.all([success.done, failure.done]);
    expect(success.draft.text).toBe("pending");
    expect(failure.draft.text).toBe("pending");
  });

  it("starts a fresh lookup after switching away and back, rejecting the earlier result", async () => {
    await renderScope(originalScope);
    const old = startLookup();
    await renderScope(pastedPullRequestReferenceScope({ ...base, repository: "repo2" }));
    await renderScope(originalScope);
    expect(scopeRef.current!.inFlight.has(7)).toBe(false);
    const current = startLookup();
    old.result.resolve({ _tag: "Success", value: "Old repository PR" });
    await old.done;
    expect(old.draft.text).toBe("pending");
    expect(scopeRef.current!.inFlight.has(7)).toBe(true);
    current.result.resolve({ _tag: "Success", value: "Current repository PR" });
    await current.done;
    expect(current.draft.text).toBe("Current repository PR");
    expect(scopeRef.current!.inFlight.has(7)).toBe(false);
  });

  it("preserves in-flight deduplication during renders of the same scope", async () => {
    await renderScope(originalScope);
    const lookup = startLookup();
    await renderScope(originalScope);
    expect(scopeRef.current!.inFlight.has(7)).toBe(true);
    lookup.result.resolve({ _tag: "Failure" });
    await lookup.done;
    expect(lookup.draft.text).toBe("#7");
  });

  it("ignores a rejected lookup after unmount", async () => {
    await renderScope(originalScope);
    const lookup = startLookup();
    await act(() => root.unmount());
    lookup.result.reject(new Error("Disconnected"));
    await lookup.done;
    expect(lookup.draft.text).toBe("pending");
  });
});
