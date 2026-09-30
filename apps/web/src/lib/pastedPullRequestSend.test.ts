import { afterEach, describe, expect, it } from "vite-plus/test";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";

import { buildPullRequestReferenceContext } from "../components/pullRequest/pullRequestDetail.logic";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
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
      const context = buildMessageContext({
        terminalContexts: [],
        previewAnnotations: [],
        reviewComments: draft.reviewComments,
      });
      const providerInput = projectComposerContextForProvider({
        text: draft.prompt,
        records: context?.records ?? [],
      });
      expect(context?.records).toHaveLength(1);
      expect(providerInput).toContain("Resolve pasted PRs");
      expect(providerInput).not.toContain('unavailable="true"');
    },
  );
  it.each([false, true])(
    "resolves through the draft store without duplicate wire IDs, legacy=%s",
    (hasLegacy) => {
      const target = DraftId.make("pasted-pr-send-test");
      const store = useComposerDraftStore.getState();
      store.setPrompt(target, prompt);
      if (hasLegacy) {
        store.addReviewComment(
          target,
          { ...resolved, pullRequest: undefined, text: "Legacy summary" },
          { appendReference: false },
        );
      }
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
      const context = buildMessageContext({
        terminalContexts: [],
        previewAnnotations: [],
        reviewComments: after.reviewComments,
      });
      const providerInput = projectComposerContextForProvider({
        text: after.prompt,
        records: context?.records ?? [],
      });
      expect(providerInput).toContain("Resolve pasted PRs");
      expect(providerInput).toContain("https://github.com/t3code/t3/pull/7");
      expect(providerInput).not.toContain('unavailable="true"');
      expect(context?.records).toHaveLength(1);
    },
  );
  it("blocks a resolvable reference until its provider context contains the summary", () => {
    const send = { prompt, reviewComments: [], canResolve: true, answeringPendingInput: false };
    expect(shouldBlockPastedPullRequestSend(send)).toBe(true);

    const ready = { ...send, reviewComments: [resolved] };
    expect(shouldBlockPastedPullRequestSend(ready)).toBe(false);
    expect(unresolvedPastedPullRequestReferences(ready.prompt, ready.reviewComments)).toEqual([]);
    const context = buildMessageContext({
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: ready.reviewComments,
    });
    const providerInput = projectComposerContextForProvider({
      text: ready.prompt,
      records: context?.records ?? [],
    });
    expect(providerInput).toContain("Resolve pasted PRs");
    expect(providerInput).toContain("https://github.com/t3code/t3/pull/7");
    expect(providerInput).not.toContain('unavailable="true"');
    expect(context?.records).toMatchObject([
      { kind: "review-comment", pullRequest: { number: 7 } },
    ]);
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
    const context = buildMessageContext({
      terminalContexts: [],
      previewAnnotations: [],
      reviewComments: [],
    });
    expect(context).toBeUndefined();
    expect(
      projectComposerContextForProvider({ text: failedPrompt, records: context?.records ?? [] }),
    ).toBe("Review #7");
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
    const providerInput = projectComposerContextForProvider({ text: prompt, records: [] });
    expect(providerInput).toContain('unavailable="true"');
    expect(providerInput).not.toContain("\ncomment:");
  });
});
