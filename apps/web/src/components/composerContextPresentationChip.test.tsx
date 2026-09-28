// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import {
  buildPendingPullRequestReferenceContext,
  reviewCommentContextId,
} from "~/lib/composerContextRecords";
import {
  ComposerContextRecordsContext,
  ComposerContextReferenceChip,
  composerContextRecordsFromDraft,
} from "./composerContextPresentation";

const pendingRecord = buildPendingPullRequestReferenceContext(11420);
const contextValue = {
  records: composerContextRecordsFromDraft({
    terminalContexts: [],
    reviewComments: [pendingRecord],
  }),
  pendingPullRequestResolvable: true,
};

it("shows a mismatched pasted PR label as unavailable even when its context has a pending record", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const renderChip = async (label: string) => {
    await act(async () => {
      root.render(
        <ComposerContextRecordsContext.Provider value={contextValue}>
          <ComposerContextReferenceChip
            kind="review-comment"
            contextId={reviewCommentContextId(pendingRecord.id)}
            label={label}
          />
        </ComposerContextRecordsContext.Provider>,
      );
    });
  };

  try {
    await renderChip("#11410");
    expect(
      container.querySelector('[data-context-unresolved="true"]')?.getAttribute("aria-label"),
    ).toBe("Unavailable context, #11410");

    await renderChip("#11420");
    expect(container.querySelector('[aria-label="Resolving pull request #11420"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
