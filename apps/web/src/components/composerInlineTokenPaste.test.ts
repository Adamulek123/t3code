import { describe, expect, it } from "vite-plus/test";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { importPastedComposerText } from "./composerInlineTokenPaste";

const marker = "[Review comment: #11420; ref=review-comment_pr-reference-11420-c3ac9552f23277bd]";

describe("importPastedComposerText", () => {
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
