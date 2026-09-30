import { afterEach, describe, expect, it } from "vite-plus/test";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";

import { buildPullRequestReferenceContext } from "../components/pullRequest/pullRequestDetail.logic";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { ReviewCommentContext } from "../reviewCommentContext";
import { formatInlineContextReference } from "./composerContextReferences";
import {
  buildMessageContext,
  resolvePastedPullRequestReferences,
  restoreFailedPastedPullRequestText,
  reviewCommentContextReference,
  shouldBlockPastedPullRequestSend,
  unresolvedPastedPullRequestReferences,
} from "./composerContextRecords";

const resolved = buildPullRequestReferenceContext({
  number: 7,
  title: "Resolve pasted PRs",
  url: "https://github.com/t3code/t3/pull/7",
  state: "open",
  isDraft: false,
  headBranch: "fix/pasted-pr",
  baseBranch: "main",
});
const prompt = `Review ${formatInlineContextReference(reviewCommentContextReference(resolved))}`;

function providerInput(text: string, reviewComments: ReviewCommentContext[]) {
  const context = buildMessageContext({
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments,
  });
  return projectComposerContextForProvider({ text, records: context?.records ?? [] });
}

afterEach(() => useComposerDraftStore.setState({ draftsByThreadKey: {} }));

describe("pasted PR provider send context", () => {
  it.each([false, true])(
    "keeps one payload when inserting a menu reference after paste resolution, duplicate link=%s",
    (allowDuplicateReference) => {
      const target = DraftId.make("pasted-pr-menu-test");
      const store = useComposerDraftStore.getState();
      store.setPrompt(target, prompt);
      for (const comment of resolvePastedPullRequestReferences(prompt, [], resolved)) {
        store.addReviewComment(target, comment, { appendReference: false });
      }
      store.addReviewComment(target, resolved, { allowDuplicateReference });
      const draft = useComposerDraftStore.getState().getComposerDraft(target)!;
      expect(draft.reviewComments).toHaveLength(1);
      if (!allowDuplicateReference) expect(draft.prompt).toBe(prompt);
      const input = providerInput(draft.prompt, draft.reviewComments);
      expect(input.match(/<context kind="review-comment"/gu)).toHaveLength(1);
      expect(input).toContain("Resolve pasted PRs");
      expect(input).not.toContain('unavailable="true"');
    },
  );
  it("blocks send until the missing record is resolved through the draft store", () => {
    const target = DraftId.make("pasted-pr-send-test");
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, prompt);
    const before = store.getComposerDraft(target)!;
    expect(
      shouldBlockPastedPullRequestSend({
        prompt: before.prompt,
        reviewComments: before.reviewComments,
        canResolve: true,
        answeringPendingInput: false,
      }),
    ).toBe(true);
    for (const comment of resolvePastedPullRequestReferences(
      before.prompt,
      before.reviewComments,
      resolved,
    )) {
      store.addReviewComment(target, comment, { appendReference: false });
    }
    const after = useComposerDraftStore.getState().getComposerDraft(target)!;
    expect(after.reviewComments).toHaveLength(1);
    expect(after.prompt).toBe(prompt);
    expect(
      shouldBlockPastedPullRequestSend({
        prompt: after.prompt,
        reviewComments: after.reviewComments,
        canResolve: true,
        answeringPendingInput: false,
      }),
    ).toBe(false);
    const input = providerInput(after.prompt, after.reviewComments);
    expect(input).toContain("Resolve pasted PRs");
    expect(input).toContain("https://github.com/t3code/t3/pull/7");
    expect(input).not.toContain('unavailable="true"');
  });

  it("sends the restored number without a summary-free context record after lookup failure", () => {
    const failedPrompt = restoreFailedPastedPullRequestText(
      prompt,
      new Set(unresolvedPastedPullRequestReferences(prompt, []).map((entry) => entry.contextId)),
    );
    expect(
      shouldBlockPastedPullRequestSend({
        prompt: failedPrompt,
        reviewComments: [],
        canResolve: true,
        answeringPendingInput: false,
      }),
    ).toBe(false);
    expect(providerInput(failedPrompt, [])).toBe("Review #7");
  });

  it("marks a missing record unavailable when no repository can resolve it", () => {
    expect(
      shouldBlockPastedPullRequestSend({
        prompt,
        reviewComments: [],
        canResolve: false,
        answeringPendingInput: false,
      }),
    ).toBe(false);
    const input = providerInput(prompt, []);
    expect(input).toContain('unavailable="true"');
    expect(input).not.toContain("\ncomment:");
  });
});
