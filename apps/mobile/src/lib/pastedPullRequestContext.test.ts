import { describe, expect, it } from "vite-plus/test";
import { rewritePastedPullRequestMarkers } from "@t3tools/shared/composerContextReferences";
import {
  hasUnresolvedPastedPullRequest,
  pendingPastedPullRequestRecords,
} from "./pastedPullRequestContext";

describe("pendingPastedPullRequestRecords", () => {
  it("creates one pending record for a plain provider marker pasted into a mobile draft", () => {
    const raw =
      "See [Review comment: #7; ref=review-comment_pr-reference-7-abcdef12] and [Review comment: #7; ref=review-comment_pr-reference-7-abcdef12]";
    expect(hasUnresolvedPastedPullRequest(raw, [])).toBe(true);
    const pasted = rewritePastedPullRequestMarkers(raw);
    const records = pendingPastedPullRequestRecords(pasted, []);
    expect(records).toMatchObject([
      {
        contextId: "review-comment_pr-reference-7-abcdef12",
        kind: "review-comment",
        label: "#7",
        filePath: "PR #7",
      },
    ]);
    expect(pendingPastedPullRequestRecords(pasted, records)).toEqual([]);
    expect(hasUnresolvedPastedPullRequest(pasted, records)).toBe(true);
    expect(
      hasUnresolvedPastedPullRequest(pasted, [
        {
          ...records[0]!,
          pullRequest: {
            number: 7,
            title: "Resolved",
            url: "https://github.com/t3code/t3/pull/7",
            headBranch: "fix",
            baseBranch: "main",
            state: "open",
            isDraft: false,
          },
        },
      ]),
    ).toBe(false);
  });

  it("does not make a pending record for a mismatched PR number", () => {
    const pasted = rewritePastedPullRequestMarkers(
      "[Review comment: #8; ref=review-comment_pr-reference-7-abcdef12]",
    );
    expect(pendingPastedPullRequestRecords(pasted, [])).toEqual([]);
  });
});
