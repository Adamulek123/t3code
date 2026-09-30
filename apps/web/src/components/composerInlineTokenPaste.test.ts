import { describe, expect, it } from "vite-plus/test";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { ComposerContextId, EnvironmentId } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { buildMessageContext } from "../lib/composerContextRecords";
import { buildPullRequestReferenceContext } from "./pullRequest/pullRequestDetail.logic";
import { importPastedComposerText } from "./composerInlineTokenPaste";

const marker = "[Review comment: #11420; ref=review-comment_pr-reference-11420-c3ac9552f23277bd]";

describe("importPastedComposerText", () => {
  it("imports and remaps records for a mixed paste of provider markers and context links", () => {
    const comment = buildPullRequestReferenceContext({
      number: 11420,
      title: "Source repository PR",
      url: "https://github.com/source/repo/pull/11420",
      headBranch: "fix/paste",
      baseBranch: "main",
      state: "open",
      isDraft: false,
    });
    const prRecord = buildMessageContext({
      reviewComments: [comment],
      terminalContexts: [],
      previewAnnotations: [],
    })!.records[0]!;
    const terminal = {
      version: 1 as const,
      kind: "terminal" as const,
      contextId: ComposerContextId.make("terminal_build"),
      label: "Build",
      terminalId: "build",
      terminalLabel: "Build",
      lineStart: 1,
      lineEnd: 1,
      text: "Build failed",
    };
    const encoded = encodeComposerContextFragment({
      version: 1,
      source: { environmentId: EnvironmentId.make("source-environment") },
      records: [prRecord, terminal, { ...terminal, contextId: ComposerContextId.make("unused") }],
    })!;
    const pasted = `[Review comment: #11420; ref=${prRecord.contextId}] and [Build](t3-context://v1/terminal/${terminal.contextId})`;
    const importedIds: string[] = [];
    const text = importPastedComposerText(
      {
        getData: (type) =>
          type === "text/plain" ? pasted : type === COMPOSER_CONTEXT_CLIPBOARD_MIME ? encoded : "",
      },
      (fragment) => {
        expect(fragment.source.environmentId).toBe("source-environment");
        importedIds.push(...fragment.records.map((record) => record.contextId));
        expect(fragment.records).toEqual([prRecord, terminal]);
        return new Map(
          fragment.records.map((record) => [record.contextId, `${record.contextId}_imported`]),
        );
      },
    );
    expect(importedIds).toEqual([prRecord.contextId, terminal.contextId]);
    expect(collectComposerContextReferences(text)).toMatchObject([
      { label: "#11420", contextId: `${prRecord.contextId}_imported` },
      { label: "Build", contextId: `${terminal.contextId}_imported` },
    ]);
  });
  it("retains every word of an ambiguous pasted PR marker", () => {
    const ambiguous = marker.replace("#11420", "fixes #5 and #11420");
    expect(importPastedComposerText({ getData: () => ambiguous })).toBe(ambiguous);
  });
  it("turns a pasted provider marker into an editor reference", () => {
    const text = importPastedComposerText({
      getData: (type) => (type === "text/plain" ? `Review ${marker} please` : ""),
    });
    expect(text).toBe(
      "Review [#11420](t3-context://v1/review-comment/review-comment_pr-reference-11420-c3ac9552f23277bd) please",
    );
    expect(collectComposerContextReferences(text)).toMatchObject([
      {
        kind: "review-comment",
        label: "#11420",
        contextId: "review-comment_pr-reference-11420-c3ac9552f23277bd",
      },
    ]);
  });

  it.each([
    [
      marker.replace("#11420", "#11421"),
      "#11421",
      "review-comment_pr-reference-11420-c3ac9552f23277bd",
    ],
    [
      "[Review comment: #14437; ref=review-comment_pr-reference-14447-06ff1614db759a87]",
      "#14437",
      "review-comment_pr-reference-14447-06ff1614db759a87",
    ],
  ])(
    "preserves a mismatched number as an unavailable editor reference: %s",
    (malformed, label, id) => {
      expect(importPastedComposerText({ getData: () => malformed })).toBe(
        `[${label}](t3-context://v1/review-comment/${id})`,
      );
    },
  );
});
