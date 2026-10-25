import { changeRequestReferenceAutolinker } from "@t3tools/client-runtime/pull-request-markdown";
import { describe, expect, it } from "vite-plus/test";

import { rehypePullRequestAutolinks } from "./pullRequestMarkdown.logic";

type Node = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

function links(markdown: string) {
  const autolinks = changeRequestReferenceAutolinker({
    provider: "github",
    url: "https://github.com/team/repo/pull/8",
  })!;
  const tree: Node = {
    type: "root",
    children: [
      { type: "text", value: markdown },
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://example.com" },
        children: [{ type: "text", value: "#13" }],
      },
      { type: "element", tagName: "code", children: [{ type: "text", value: "#14" }] },
    ],
  };
  rehypePullRequestAutolinks({ autolinks })(tree as never);
  const found: Array<[string | undefined, unknown, unknown]> = [];
  const visit = (node: Node) => {
    if (node.tagName === "a") {
      found.push([
        node.children?.[0]?.value,
        node.properties?.href,
        node.properties?.dataPullRequestAutolink,
      ]);
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  return found;
}

describe("rehypePullRequestAutolinks", () => {
  it("links the host's references in prose and leaves links and code alone", () => {
    expect(links("Fixes #12 in abcdef1.")).toEqual([
      ["#12", "https://github.com/team/repo/issues/12", "reference"],
      ["abcdef1", "https://github.com/team/repo/commit/abcdef1", "commit"],
      ["#13", "https://example.com", undefined],
    ]);
  });
});
