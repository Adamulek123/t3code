// @vitest-environment jsdom

import { act, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { reviewCommentContextId } from "~/lib/composerContextRecords";
import { buildPullRequestReferenceContext } from "./pullRequest/pullRequestDetail.logic";
import {
  ComposerContextRecordsContext,
  ComposerContextReferenceChip,
  composerContextRecordsFromDraft,
} from "./composerContextPresentation";

const resolved = buildPullRequestReferenceContext({
  number: 11420,
  title: "Fix the loader",
  url: "https://github.com/t3code/t3/pull/11420",
  headBranch: "fix/loader",
  baseBranch: "main",
  state: "open",
  isDraft: false,
});

function ChipProbe({
  label,
  reviewComments,
  pendingPullRequestResolvable,
}: {
  label: string;
  reviewComments: ReviewCommentContext[];
  pendingPullRequestResolvable: boolean;
}) {
  const contextValue = useMemo(
    () => ({
      records: composerContextRecordsFromDraft({ terminalContexts: [], reviewComments }),
      pendingPullRequestResolvable,
    }),
    [reviewComments, pendingPullRequestResolvable],
  );
  return (
    <ComposerContextRecordsContext.Provider value={contextValue}>
      <ComposerContextReferenceChip
        kind="review-comment"
        contextId={reviewCommentContextId(resolved.id)}
        label={label}
      />
    </ComposerContextRecordsContext.Provider>
  );
}

it("loads a pasted reference without a placeholder record, then displays its resolved PR", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const renderChip = async (
    label: string,
    reviewComments: ReviewCommentContext[] = [],
    pendingPullRequestResolvable = true,
  ) => {
    await act(async () => {
      root.render(
        <ChipProbe
          label={label}
          reviewComments={reviewComments}
          pendingPullRequestResolvable={pendingPullRequestResolvable}
        />,
      );
    });
  };
  const loadingChip = () => container.querySelector('[aria-label="Resolving pull request #11420"]');
  const unavailableChip = () => container.querySelector('[data-context-unresolved="true"]');

  try {
    await renderChip("#11420");
    expect(loadingChip()).not.toBeNull();

    await renderChip("#11410");
    expect(unavailableChip()?.getAttribute("aria-label")).toBe("Unavailable context, #11410");

    await renderChip("#11420", [], false);
    expect(loadingChip()).toBeNull();
    expect(unavailableChip()).not.toBeNull();

    const legacy = { ...resolved, pullRequest: undefined };
    await renderChip("#11410", [legacy]);
    expect(unavailableChip()?.getAttribute("aria-label")).toBe("Unavailable context, #11410");

    await renderChip("#11420", [legacy]);
    expect(loadingChip()).not.toBeNull();

    await renderChip("#11420", [resolved]);
    expect(loadingChip()).toBeNull();
    expect(unavailableChip()).toBeNull();
    expect(container.textContent).toContain("#11420");

    for (const label of ["Release notes", "Release notes for #11420", "Fixes #5 and #11420"]) {
      await renderChip(label, [resolved]);
      expect(unavailableChip()).toBeNull();
      expect(loadingChip()).toBeNull();
      expect(container.textContent).toContain("#11420");
    }

    await renderChip("#11410", [resolved]);
    expect(unavailableChip()?.getAttribute("aria-label")).toBe("Unavailable context, #11410");
    expect(loadingChip()).toBeNull();
    expect(container.textContent).toBe("#11410");
    expect(container.querySelector("svg.lucide-circle-dashed")).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      (unavailableChip() as HTMLElement).focus();
    });
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
      "This pasted PR number doesn't match its reference. Remove it and paste the correct PR reference.",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
