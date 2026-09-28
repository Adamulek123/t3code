import { ComposerContextId } from "@t3tools/contracts";
import type { ComposerContextRecord, ReviewCommentContextRecord } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  rewritePastedPullRequestMarkers,
  selfConsistentPastedPullRequestNumber,
} from "@t3tools/shared/composerContextReferences";

/** Creates draft records for pasted PR links whose clipboard carried no record. */
export function pendingPastedPullRequestRecords(
  text: string,
  existing: ReadonlyArray<ComposerContextRecord>,
): ReviewCommentContextRecord[] {
  const knownIds = new Set(existing.map((record) => record.contextId));
  const pending: ReviewCommentContextRecord[] = [];
  for (const reference of collectComposerContextReferences(text)) {
    if (knownIds.has(reference.contextId)) continue;
    const number = selfConsistentPastedPullRequestNumber(reference.label, reference.contextId);
    if (number === null) continue;
    knownIds.add(reference.contextId);
    pending.push({
      version: 1,
      kind: "review-comment",
      contextId: ComposerContextId.make(reference.contextId),
      label: `#${number}`,
      sectionId: `pull-request:${number}`,
      sectionTitle: `PR #${number}`,
      filePath: `PR #${number}`,
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "",
      text: "",
      diff: "",
    });
  }
  return pending;
}

export function hasUnresolvedPastedPullRequest(
  text: string,
  records: ReadonlyArray<ComposerContextRecord>,
): boolean {
  const byId = new Map(records.map((record) => [record.contextId, record]));
  return collectComposerContextReferences(rewritePastedPullRequestMarkers(text)).some(
    (reference) => {
      if (selfConsistentPastedPullRequestNumber(reference.label, reference.contextId) === null) {
        return false;
      }
      const record = byId.get(reference.contextId);
      return !(record?.kind === "review-comment" && "pullRequest" in record && record.pullRequest);
    },
  );
}
