import type {
  EnvironmentId,
  PullRequestAction,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestState,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  ArrowLeftIcon,
  ArrowUpRightIcon,
  BookOpenIcon,
  CircleDotIcon,
  ChevronDownIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HammerIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useCopyToClipboard, writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useEnvironmentQuery } from "~/state/query";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { PullRequestDetailGhost, PullRequestTimelineGhost } from "./PullRequestGhosts";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import type { PullRequestAskSelectionInput } from "./PullRequestCodeTab";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import {
  allowedPullRequestMergeMethods,
  buildAskAboutLinesHandoff,
  buildAskAboutPullRequestHandoff,
  buildExplainPullRequestHandoff,
  buildFixFindingHandoff,
  buildFixFindingsHandoff,
  buildResolveConflictsPrompt,
  canPerformPullRequestAction,
  isPullRequestConflicting,
  pullRequestFindingKey,
  resolvePullRequestPrimaryAction,
  resolveSelectedMergeMethod,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";
import { usePullRequestActionRunner, usePullRequestHandoffs } from "./usePullRequestActions";
import {
  PullRequestActorLabel,
  PullRequestDiffStat,
  PullRequestMetaLine,
  resolvePullRequestState,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";

type DetailTab = "summary" | "timeline" | "code";

/** Named for the host rather than "externally": the point is where you will land. */
const OPEN_ON_HOST_LABELS: Partial<Record<string, string>> = {
  github: "Open on GitHub",
  gitlab: "Open on GitLab",
  bitbucket: "Open on Bitbucket",
  "azure-devops": "Open on Azure DevOps",
};

const TABS: ReadonlyArray<{ value: DetailTab; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

// The diff viewer pulls in its worker pool, so it stays out of the bundle until Code is opened.
// Named rather than inlined so the panel can also call it itself, to start the download before
// anyone has clicked the tab.
const loadCodeTab = () => import("./PullRequestCodeTab");
const PullRequestCodeTab = lazy(loadCodeTab);

export function PullRequestDetailPanel({
  environmentId,
  reference,
  refreshToken: forcedRefreshToken = 0,
  onActed,
  onClose,
  onStateChange,
  context = "page",
  chromeVariant = "full",
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /**
   * Bumped by whatever holds the panel when a reader asks for everything on screen to be read
   * again. The panel owns its own reads, so the page cannot refresh them for it — it says when,
   * and this says it.
   */
  refreshToken?: number;
  /**
   * An action changed this pull request on the host, so a list showing it is now out of date.
   * Told rather than assumed: only the page knows whether it is showing one.
   */
  onActed?: () => void;
  /** Page-owned detail columns use this to clear the selected pull request. */
  onClose?: () => void;
  /** Keeps compact chrome, such as the right-panel tab, in step with refreshed host state. */
  onStateChange?: (status: {
    projectId: string;
    repository: string;
    number: number;
    state: PullRequestState;
    isDraft: boolean;
  }) => void;
  /**
   * Beside a thread, the checkout affordance disappears: the panel is showing that thread's
   * own pull request, so the branch is already under the reader's feet — and checking it out
   * again is at best a no-op and at worst git refusing a branch two checkouts.
   */
  context?: "page" | "thread";
  /**
   * How the metadata above the content behaves: `full` keeps every row pinned; `collapse`
   * folds the whole of it into the top row once the active tab scrolls, and unfolds at the
   * top — the chrome spends its height on what is being read.
   */
  chromeVariant?: "full" | "collapse";
}) {
  const pullRequestKey = `${reference.projectId}:${reference.repository}#${reference.number}`;
  const [tab, setTab] = useState<DetailTab>("summary");
  const [timelineOrder, setTimelineOrder] = useState<"newest" | "oldest">("newest");
  const [codeCommitScope, setCodeCommitScope] = useState<{
    readonly pullRequestKey: string;
    readonly oid: string | null;
  }>(() => ({ pullRequestKey, oid: null }));
  const selectedCodeCommitOid =
    codeCommitScope.pullRequestKey === pullRequestKey ? codeCommitScope.oid : null;
  const selectCodeCommit = (oid: string | null) => {
    setCodeCommitScope({ pullRequestKey, oid });
  };
  const openCommit = (oid: string) => {
    selectCodeCommit(oid);
    setTab("code");
  };
  // Every tab the reader has opened stays mounted behind the active one. The diff viewer
  // always needed this (it virtualizes against its own scroll position); the trace showed the
  // summary needs it too — a large description re-parses its whole markdown on every return
  // to the tab. `visibility` keeps boxes, sizes and scroll offsets, and takes hidden content
  // out of the tab order and the accessibility tree.
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<DetailTab>>(
    () => new Set<DetailTab>(["summary"]),
  );
  useEffect(() => {
    setMountedTabs((previous) =>
      previous.has(tab) ? previous : new Set<DetailTab>(previous).add(tab),
    );
  }, [tab]);
  const [chromeCondensed, setChromeCondensed] = useState(false);
  // Each tab remembers whether its chrome was condensed. Only the active tab can emit scroll
  // events, so the capture handler always writes the active tab's entry — and a tab switch
  // reads the destination's memory instead of inheriting the tab being left. A tab too short
  // to scroll remembers "expanded", which is what keeps it from being stranded under a chrome
  // it has no scrollbar to reopen.
  const chromeStateByTab = useRef<Partial<Record<DetailTab, boolean>>>({});
  useEffect(() => {
    setChromeCondensed(chromeStateByTab.current[tab] ?? false);
  }, [tab]);
  const condensed = chromeVariant === "collapse" && chromeCondensed;
  // Collapsing removes the fold's height from the chrome, which would otherwise hand that
  // height to the scrollport and leap the content up by it mid-scroll. The cure is exact
  // compensation: collapse only once the reader has scrolled at least the fold's height,
  // then give that height back to `scrollTop` before the next paint — the content under
  // their eyes does not move, and the collapse itself is the only thing that changes.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const foldRef = useRef<HTMLDivElement | null>(null);
  // The condensed chrome's second row opens as the fold closes, so the height the scrollport
  // gains is the fold's minus this row's. Measured the same way the fold is: `scrollHeight`
  // through a zero track reads its natural height in either state.
  const condensedRowRef = useRef<HTMLDivElement | null>(null);
  const compensationRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (compensationRef.current === null) return;
    const scroller = scrollerRef.current;
    const delta = compensationRef.current;
    compensationRef.current = null;
    if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
  }, [condensed]);
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>("merge");
  const [confirmAction, setConfirmAction] = useState<"merge" | "close" | null>(null);
  const { copyToClipboard: copyBranchToClipboard, isCopied: isBranchCopied } = useCopyToClipboard({
    target: "branch name",
    timeout: 1600,
  });

  // The chunk is fetched as soon as the panel exists rather than waiting for the Code tab to be
  // clicked, so a reader who does click it lands on a chunk already in the module cache.
  useEffect(() => {
    void loadCodeTab();
  }, []);

  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const activityQuery = useEnvironmentQuery(
    pullRequestEnvironment.activity({ environmentId, input: reference }),
  );
  // Detail and diff are independent server reads, so the diff for the default view (no commit,
  // no cursor) is started here too rather than waiting for the Code tab to mount. This is one
  // extra cached read per opened pull request even for readers who never open the tab, but it
  // turns the tab's first paint from a cold request into a cache hit.
  const _diffWarmUpQuery = useEnvironmentQuery(
    pullRequestEnvironment.diff({ environmentId, input: { ...reference } }),
  );
  const coreDetail = detailQuery.data;
  const activity = activityQuery.data;
  const detail = useMemo(
    () =>
      coreDetail === null
        ? null
        : {
            ...coreDetail,
            author: activity?.author ?? coreDetail.author,
            reviewers: activity?.reviewers ?? coreDetail.reviewers,
            comments: activity?.comments ?? [],
            commentCount: activity?.commentCount ?? 0,
            commentsTruncated: activity?.commentsTruncated ?? false,
            reviewThreads: activity?.reviewThreads ?? [],
            commits: activity?.commits ?? [],
          },
    [activity, coreDetail],
  );
  const activityPending = activityQuery.isPending && activity === null;
  const activityError = activity === null ? activityQuery.error : null;
  const refreshDetail = useCallback(() => {
    detailQuery.refresh();
    activityQuery.refresh();
  }, [activityQuery.refresh, detailQuery.refresh]);
  useEffect(() => {
    if (!detail) return;
    onStateChange?.({
      projectId: detail.projectId,
      repository: detail.repository,
      number: detail.number,
      state: detail.state,
      isDraft: detail.isDraft,
    });
  }, [detail, onStateChange]);
  // A pull request changes while it is open in front of somebody — a push lands, a check
  // finishes, a review arrives — so the panel reads it again on the way back to the window and
  // while a reader sits on it. Keyed by the pull request rather than by the panel, because this
  // one panel shows a different pull request every time it is opened.
  useLiveRefresh(refreshDetail, {
    key: `pull-request:${reference.projectId}:${reference.repository}#${reference.number}`,
  });
  // The button, on the other hand, goes around the server's cache rather than through it: it is
  // the answer for a reader who can see that what they are looking at is behind. The
  // invalidation goes first so the re-reads miss that cache; if it fails, the reads still run
  // and at worst answer from it.
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshFromHost = useCallback(async () => {
    await invalidate({ environmentId, input: { reference } });
    refreshDetail();
    setRefreshToken((token) => token + 1);
  }, [environmentId, invalidate, reference, refreshDetail]);
  // A refresh asked for by the page: the detail, and through the token below, the diff with it.
  const appliedForcedToken = useRef(forcedRefreshToken);
  useEffect(() => {
    if (appliedForcedToken.current === forcedRefreshToken) return;
    appliedForcedToken.current = forcedRefreshToken;
    void refreshFromHost();
  }, [forcedRefreshToken, refreshFromHost]);
  const { actionPending, perform } = usePullRequestActionRunner({
    environmentId,
    reference,
    onSuccess: () => {
      refreshDetail();
      onActed?.();
    },
  });
  const { handoff, startAsk, startHandoff } = usePullRequestHandoffs({ environmentId, detail });

  const askAboutPullRequest = () => {
    if (!detail) return;
    void startAsk("ask", {
      ...buildAskAboutPullRequestHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  const explainPullRequest = () => {
    if (!detail) return;
    void startAsk("explain", {
      ...buildExplainPullRequestHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  /** Lines the reader marked in the diff, asked about rather than commented on. */
  const askAboutSelection = (selection: PullRequestAskSelectionInput) => {
    if (!detail) return;
    void startAsk(`ask:${selection.comment.id}`, {
      ...buildAskAboutLinesHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        comment: selection.comment,
        question: selection.question,
      }),
    });
  };

  const startCheckout = (mode: "worktree" | "local") => {
    if (!detail) return;
    void startHandoff(`checkout:${mode}`, null, mode);
  };

  /** One finding, handed over on its own — the surfaces that show findings call this. */
  const startFixFinding = (finding: PullRequestFinding) => {
    if (!detail) return;
    void startHandoff(
      pullRequestFindingKey(finding),
      buildFixFindingHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        finding,
      }),
    );
  };

  const startFixFindings = () => {
    if (!detail) return;
    void startHandoff(
      "findings",
      buildFixFindingsHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        reviewThreads: detail.reviewThreads,
        comments: detail.comments,
        checks: detail.checks,
        commentsTruncated: detail.commentsTruncated,
      }),
    );
  };

  const startResolveConflicts = () => {
    if (!detail) return;
    void startHandoff("conflicts", {
      prompt: buildResolveConflictsPrompt({
        number: detail.number,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
      }),
    });
  };

  const allowedMergeMethods = allowedPullRequestMergeMethods(detail);
  const selectedMergeMethod = resolveSelectedMergeMethod(allowedMergeMethods, mergeMethod);
  const conflicting = isPullRequestConflicting(detail);
  // A host that cannot produce a patch has no Code tab to open. The tabs themselves stay hidden
  // until the detail arrives, so the loading ghost is the panel's only unfinished UI.
  const visibleTabs = TABS.filter(
    (item) => item.value !== "code" || detail === null || detail.capabilities.diff,
  );
  // The Code tab can be opened while the detail is still on its way, and the detail may then say
  // this host has no patch to show. The tab goes, so whoever was standing on it is moved back to
  // the summary rather than left looking at a panel that is no longer reachable.
  useEffect(() => {
    if (!visibleTabs.some((item) => item.value === tab)) setTab("summary");
  }, [tab, visibleTabs]);
  const can = (action: PullRequestAction) => canPerformPullRequestAction(detail, action);
  const primaryAction = resolvePullRequestPrimaryAction(detail);
  // The pull request number carries this state in the overview and the right-panel tab mirrors
  // it. Conflicts keep their own row below: an open pull request remains green there.
  const statePresentation = detail
    ? resolvePullRequestState({ state: detail.state, isDraft: detail.isDraft })
    : null;
  const checksSummary = detail ? summarizePullRequestChecks(detail.checks) : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      {/* The top row's geometry never changes: both of its states occupy the same stacked
          cell and crossfade, so the actions on the right have one home whatever the chrome
          is doing below. The fold and this fade share one 200ms clock. */}
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 border-b border-border/60">
        {/* The fixed height lives on the two top-row cells — not the grid, whose later rows
            are the fold — so the actions have one immovable home in both states. */}
        <div className="ml-4 grid h-11 min-w-0 items-center">
          <div
            aria-hidden={condensed}
            inert={condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground transition-opacity sm:text-xs motion-reduce:transition-none",
              // Sequenced, not simultaneous: the leaving layer clears quickly before the
              // arriving one lands, so no frame shows both texts superimposed at half opacity.
              condensed
                ? "pointer-events-none opacity-0 duration-100"
                : "opacity-100 delay-75 duration-150",
            )}
          >
            {detail && statePresentation ? (
              <>
                <span className="min-w-0 truncate" title={detail.repository}>
                  {detail.repository}
                </span>
                <button
                  type="button"
                  onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}
                  className={cn(
                    "shrink-0 font-medium underline-offset-2 hover:underline",
                    statePresentation.toneClassName,
                  )}
                  title={OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host"}
                  aria-label={`Open pull request #${detail.number} on host`}
                >
                  #{detail.number}
                </button>
              </>
            ) : null}
          </div>
          <div
            aria-hidden={!condensed}
            inert={!condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 text-sm transition-opacity sm:text-xs motion-reduce:transition-none",
              condensed
                ? "opacity-100 delay-75 duration-150"
                : "pointer-events-none opacity-0 duration-100",
            )}
          >
            {detail && statePresentation ? (
              <>
                <button
                  type="button"
                  tabIndex={condensed ? 0 : -1}
                  onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}
                  className={cn(
                    "shrink-0 font-medium underline-offset-2 hover:underline",
                    statePresentation.toneClassName,
                  )}
                  title={OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host"}
                  aria-label={`Open pull request #${detail.number} on host`}
                >
                  #{detail.number}
                </button>
                <span className="min-w-0 truncate font-medium text-foreground" title={detail.title}>
                  {detail.title}
                </span>
                {conflicting ? (
                  <Badge
                    variant="error"
                    className="h-5 shrink-0 gap-1 rounded px-1.5 text-[10px] text-destructive"
                  >
                    <TriangleAlertIcon className="size-3" />
                    Conflicts
                  </Badge>
                ) : checksSummary ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {checksSummary}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        <div className="mr-4 flex h-11 min-w-0 flex-nowrap items-center justify-end gap-1">
          {detail ? (
            <>
              <Menu>
                <MenuTrigger
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="More pull request actions"
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end" side="bottom" className="min-w-72">
                  <MenuItem disabled={detailQuery.isPending} onClick={() => void refreshFromHost()}>
                    <RefreshCwIcon className="size-3.5" />
                    Refresh
                  </MenuItem>
                  <MenuItem disabled={handoff !== null} onClick={askAboutPullRequest}>
                    <MessageCircleQuestionIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>{handoff === "ask" ? "Opening..." : "Ask a question"}</span>
                      <span className="text-xs text-muted-foreground">
                        Opens a thread that knows which pull request you mean.
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem disabled={handoff !== null} onClick={explainPullRequest}>
                    <BookOpenIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>{handoff === "explain" ? "Opening..." : "Explain this PR"}</span>
                      <span className="text-xs text-muted-foreground">
                        A walk through the diff and what to read closely.
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem disabled={handoff !== null} onClick={startFixFindings}>
                    <HammerIcon className="size-3.5" />
                    {handoff === "findings" ? "Preparing..." : "Fix findings in a thread"}
                  </MenuItem>
                  <MenuSeparator />
                  {detail.state === "open" ? (
                    <>
                      {/* Only where the button row could not take it: "Ready for review" on a
                          draft is the primary header button, so offering it here as well would
                          show the same action twice. */}
                      {can(detail.isDraft ? "ready" : "draft") &&
                      !(detail.isDraft && primaryAction === "ready") ? (
                        <MenuItem
                          disabled={actionPending}
                          onClick={() => void perform(detail.isDraft ? "ready" : "draft")}
                        >
                          {detail.isDraft ? (
                            <GitPullRequestIcon className="size-3.5" />
                          ) : (
                            <GitPullRequestDraftIcon className="size-3.5" />
                          )}
                          {detail.isDraft ? "Ready for review" : "Convert to draft"}
                        </MenuItem>
                      ) : null}
                      {/* A preference for the merge action rather than a second action, so it
                          is a radio group here instead of a chevron welded to the Merge pill.
                          Hidden while conflicting: every method would fail. */}
                      {/* Only where merging is on offer at all: a strategy to merge with is not
                          a choice for someone who may not merge. */}
                      {can("merge") &&
                      !detail.isDraft &&
                      !conflicting &&
                      allowedMergeMethods.length > 1 ? (
                        <>
                          <MenuSeparator />
                          <MenuRadioGroup
                            value={selectedMergeMethod}
                            onValueChange={(method) =>
                              setMergeMethod(method as PullRequestMergeMethod)
                            }
                          >
                            {allowedMergeMethods.map((method) => (
                              <MenuRadioItem key={method} value={method} disabled={actionPending}>
                                {/* The radio item lays its children out as one block, so the
                                    icon and the label need their own row to share a line. */}
                                <span className="flex min-w-0 items-center gap-2">
                                  <GitMergeIcon className="size-3.5" />
                                  <span className="capitalize">{method}</span>
                                </span>
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </>
                      ) : null}
                      <MenuSeparator />
                    </>
                  ) : null}
                  <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}>
                    <ArrowUpRightIcon className="size-3.5" />
                    {OPEN_ON_HOST_LABELS[detail.provider] ?? "Open on host"}
                  </MenuItem>
                  <MenuItem onClick={() => void writeTextToClipboard(detail.url)}>
                    <LinkIcon className="size-3.5" />
                    Copy link
                  </MenuItem>
                  {/* Only where the button row could not take it, so it is never offered twice. */}
                  {conflicting && primaryAction !== "resolve" ? (
                    <MenuItem disabled={handoff !== null} onClick={startResolveConflicts}>
                      <GitMergeIcon className="size-3.5" />
                      {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts in a thread"}
                    </MenuItem>
                  ) : null}
                  {detail.state === "open" && can("close") ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        disabled={actionPending}
                        onClick={() => setConfirmAction("close")}
                      >
                        <GitPullRequestClosedIcon className="size-3.5" />
                        Close pull request
                      </MenuItem>
                    </>
                  ) : detail.state === "closed" && can("reopen") ? (
                    <>
                      <MenuSeparator />
                      <MenuItem disabled={actionPending} onClick={() => void perform("reopen")}>
                        <GitPullRequestIcon className="size-3.5" />
                        Reopen pull request
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
              {/* Checking a pull request out is the reason to open one here at all, so it is a
                  button of its own rather than a side effect of asking an agent for something.
                  It asks where, because the two answers are not interchangeable: one leaves your
                  work where it is, the other moves the repository you are standing in. Only on
                  the page: beside a thread the branch is already checked out right there. */}
              {context === "page" ? (
                <Menu>
                  <MenuTrigger
                    disabled={handoff !== null}
                    render={
                      <Button size="xs" variant="outline">
                        {handoff?.startsWith("checkout") ? (
                          "Checking out..."
                        ) : (
                          <>
                            <GitBranchIcon className="size-3" />
                            Check out
                            <ChevronDownIcon className="size-3 text-muted-foreground" />
                          </>
                        )}
                      </Button>
                    }
                  />
                  <MenuPopup align="end" side="bottom" className="min-w-72">
                    <MenuItem onClick={() => startCheckout("worktree")}>
                      <GitBranchIcon className="mt-0.5 size-3.5 shrink-0 self-start" />
                      <span className="flex min-w-0 flex-col">
                        <span>In a separate worktree</span>
                        <span className="text-xs text-muted-foreground">
                          Its own folder and thread. Nothing you have open moves.
                        </span>
                      </span>
                    </MenuItem>
                    <MenuItem onClick={() => startCheckout("local")}>
                      <FolderGit2Icon className="mt-0.5 size-3.5 shrink-0 self-start" />
                      <span className="flex min-w-0 flex-col">
                        <span>In this repository</span>
                        <span className="text-xs text-muted-foreground">
                          Switches the branch you are working in, like `gh pr checkout`.
                        </span>
                      </span>
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              ) : null}
              {primaryAction === "ready" ? (
                <Button size="xs" disabled={actionPending} onClick={() => void perform("ready")}>
                  Ready for review
                </Button>
              ) : primaryAction === "merge" ? (
                <Button
                  size="xs"
                  disabled={actionPending}
                  onClick={() => setConfirmAction("merge")}
                >
                  {actionPending ? "Merging..." : "Merge"}
                </Button>
              ) : null}
            </>
          ) : null}
          {onClose ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Collapse pull request panel"
              onClick={onClose}
            >
              <PanelRightIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>

        {/* The condensed chrome's second row: the tabs that the closing fold takes with it,
            and compact copies of the branch pair and diff stat so they stay in sight while
            the full rows are folded away. Same zero-track mechanism as the fold, inverted. */}
        <div className={cn("col-span-2 grid", condensed ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
          <div
            ref={condensedRowRef}
            className={cn(
              "min-h-0 overflow-hidden",
              condensed
                ? "opacity-100 transition-opacity duration-200 ease-out motion-reduce:transition-none"
                : "opacity-0",
            )}
            inert={!condensed}
          >
            {detail ? (
              <div className="flex min-w-0 items-center gap-1 px-4 pb-2">
                <nav aria-label="Pull request tabs" className="flex shrink-0 items-center gap-0.5">
                  {visibleTabs.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      tabIndex={condensed ? 0 : -1}
                      aria-pressed={tab === item.value}
                      onClick={() => setTab(item.value)}
                      className={cn(
                        "rounded-md px-2 py-1 text-[11px] transition-colors",
                        tab === item.value
                          ? "bg-accent text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </nav>
                <span
                  className="ml-auto inline-flex min-w-0 shrink items-center gap-1 font-mono text-[11px] text-muted-foreground"
                  title={`${detail.baseBranch} ← ${detail.headBranch}`}
                >
                  <span className="truncate">{detail.baseBranch}</span>
                  <ArrowLeftIcon aria-label="receives changes from" className="size-3 shrink-0" />
                  <span className="truncate">{detail.headBranch}</span>
                </span>
                <span className="ml-2 inline-flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <FileDiffIcon className="size-3" />
                    {detail.changedFiles.toLocaleString()}
                  </span>
                  <PullRequestDiffStat
                    additions={detail.additions}
                    deletions={detail.deletions}
                    className="shrink-0 font-mono text-[11px]"
                  />
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Folding is a grid track going to zero: the rows below stay mounted, the track
            animates closed over them, and `inert` takes the hidden controls out of the tab
            order for as long as the chrome is condensed. */}
        <div
          className={cn(
            "col-span-2 grid",
            // Instant in both directions: the scroll compensation keeps the content pinned
            // through either flip, and an animated track would fight it frame by frame. The
            // top row's crossfade is the transition.
            condensed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
          )}
        >
          <div
            ref={foldRef}
            // One-way on purpose: appearing content eases in over ground the instant track
            // already reserved; departing content cuts, because its ground is gone in the
            // same frame and the scroll compensation reads it as scrolled past.
            className={cn(
              "min-h-0 overflow-hidden",
              condensed
                ? "opacity-0"
                : "opacity-100 transition-opacity duration-200 ease-out motion-reduce:transition-none",
            )}
            inert={condensed}
          >
            {detail ? (
              <div className="col-span-2 mt-3 min-w-0 px-4 pb-4">
                <h1 className="text-base font-semibold leading-snug">{detail.title}</h1>
                <PullRequestMetaLine className="mt-2 text-xs text-muted-foreground">
                  <PullRequestActorLabel actor={detail.author} className="font-medium" />
                  <span>updated {formatRelativeTimeLabel(detail.updatedAt)}</span>
                </PullRequestMetaLine>

                <div className="mt-4 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <code
                    className="min-w-0 max-w-48 shrink truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground"
                    title={detail.baseBranch}
                  >
                    {detail.baseBranch}
                  </code>
                  <ArrowLeftIcon aria-label="receives changes from" className="size-4 shrink-0" />
                  <button
                    type="button"
                    className="grid min-w-0 max-w-64 shrink cursor-pointer rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                    aria-label={isBranchCopied ? "Branch name copied" : "Copy pull request branch"}
                    title={isBranchCopied ? "Copied" : "Copy pull request branch"}
                    onClick={() => copyBranchToClipboard(detail.headBranch)}
                  >
                    <code
                      className={cn(
                        "col-start-1 row-start-1 min-w-0 truncate transition-opacity duration-150 motion-reduce:transition-none",
                        isBranchCopied ? "opacity-0" : "opacity-100",
                      )}
                      title={detail.headBranch}
                    >
                      {detail.headBranch}
                    </code>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "col-start-1 row-start-1 truncate text-center transition-opacity duration-150 motion-reduce:transition-none",
                        isBranchCopied ? "opacity-100" : "opacity-0",
                      )}
                    >
                      Copied
                    </span>
                  </button>
                  <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2">
                    <span className="inline-flex items-center gap-1.5 tabular-nums">
                      <FileDiffIcon className="size-3.5" />
                      {detail.changedFiles.toLocaleString()}{" "}
                      {detail.changedFiles === 1 ? "file" : "files"}
                    </span>
                    <PullRequestDiffStat
                      additions={detail.additions}
                      deletions={detail.deletions}
                      className="shrink-0 font-mono text-xs"
                    />
                  </span>
                </div>
              </div>
            ) : null}

            {detail && conflicting ? (
              <div className="col-span-2 flex items-center gap-1 px-4 pb-3">
                <Badge
                  variant="error"
                  className="h-auto gap-1.5 rounded-md px-3 py-1.5 text-xs text-destructive"
                >
                  <TriangleAlertIcon className="size-3.5" />
                  Merge conflicts
                </Badge>
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto text-destructive hover:bg-destructive/8 hover:text-destructive"
                  disabled={handoff !== null}
                  onClick={startResolveConflicts}
                >
                  {handoff === "conflicts" ? "Preparing..." : "Resolve in a new thread"}
                  <ArrowUpRightIcon className="size-3.5 text-destructive" />
                </Button>
              </div>
            ) : null}

            {detail ? (
              <nav
                className="col-span-2 flex min-w-0 items-center gap-1 overflow-x-auto border-t border-border/60 px-4 py-2"
                aria-label="Pull request tabs"
              >
                {visibleTabs.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={tab === item.value}
                    onClick={() => setTab(item.value)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors",
                      tab === item.value
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
                {tab === "summary" ? (
                  <span
                    className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                    aria-label={checksSummary ? `Checks: ${checksSummary}` : "Checks"}
                  >
                    <CircleDotIcon aria-hidden className="size-3.5" />
                    {checksSummary}
                  </span>
                ) : tab === "timeline" ? (
                  <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    <PullRequestMetaLine
                      className={cn(
                        "whitespace-nowrap text-[11px] transition-opacity",
                        (activityPending || activityError) && "opacity-35",
                      )}
                    >
                      <span
                        className="inline-flex items-center gap-1"
                        aria-label={
                          activityError
                            ? "Comments unavailable"
                            : `${detail.commentCount.toLocaleString()} ${
                                detail.commentCount === 1 ? "comment" : "comments"
                              }`
                        }
                      >
                        <MessageSquareIcon aria-hidden className="size-3" />
                        {activityError
                          ? "—"
                          : activityPending
                            ? "…"
                            : detail.commentCount.toLocaleString()}
                      </span>
                      <span
                        className="inline-flex items-center gap-1"
                        aria-label={
                          activityError
                            ? "Commits unavailable"
                            : `${detail.commits.length.toLocaleString()} ${
                                detail.commits.length === 1 ? "commit" : "commits"
                              }`
                        }
                      >
                        <GitCommitHorizontalIcon aria-hidden className="size-3" />
                        {activityError
                          ? "—"
                          : activityPending
                            ? "…"
                            : detail.commits.length.toLocaleString()}
                      </span>
                    </PullRequestMetaLine>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="h-7 px-2 text-[10px] text-muted-foreground"
                      aria-label={
                        timelineOrder === "newest"
                          ? "Show oldest activity first"
                          : "Show newest activity first"
                      }
                      onClick={() =>
                        setTimelineOrder((value) => (value === "newest" ? "oldest" : "newest"))
                      }
                    >
                      <ArrowDownUpIcon aria-hidden className="size-3" />
                      {timelineOrder === "newest" ? "Newest first" : "Oldest first"}
                    </Button>
                  </div>
                ) : null}
              </nav>
            ) : null}
          </div>
        </div>
      </div>

      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        // Scroll does not bubble, but it captures: one listener hears every tab's own scroll
        // container. Collapse past two line-heights, expand only back at the very top, so the
        // boundary row cannot flap the chrome open and shut.
        onScrollCapture={(event) => {
          if (chromeVariant !== "collapse") return;
          const scroller = event.target as HTMLElement;
          scrollerRef.current = scroller;
          const top = scroller.scrollTop;
          setChromeCondensed((previous) => {
            let next = previous;
            // `scrollHeight` reads the fold's natural height whichever state the track is in.
            const foldHeight = foldRef.current?.scrollHeight ?? 0;
            // The chrome trades the fold for the condensed second row, so the height the
            // scrollport actually gains is the difference between the two.
            const chromeDelta = foldHeight - (condensedRowRef.current?.scrollHeight ?? 0);
            if (previous) {
              // The hard top reopens the chrome. The refund puts the reader a fold's height
              // from the top, pinned to the same pixels — the metadata is scrolled up to,
              // not thrown at them.
              if (top < 4 && foldHeight > 0) {
                compensationRef.current = chromeDelta;
                next = false;
              }
            } else if (foldHeight > 0 && top > foldHeight + 32) {
              compensationRef.current = -chromeDelta;
              next = true;
            }
            chromeStateByTab.current[tab] = next;
            return next;
          });
        }}
      >
        {detailQuery.isPending && !detail ? (
          // The ghost wears the shape of the tab being waited on, so switching tabs mid-load
          // does not flash a summary outline under a timeline heading.
          tab === "timeline" ? (
            <PullRequestTimelineGhost />
          ) : tab === "code" ? (
            <DiffPanelLoadingState label="Loading pull request diff..." />
          ) : (
            <PullRequestDetailGhost />
          )
        ) : detailQuery.error && !detail ? (
          <PullRequestsUnavailableState error={detailQuery.error} onRetry={refreshDetail} />
        ) : detail ? (
          <>
            {mountedTabs.has("summary") ? (
              <div className={cn("absolute inset-0", tab !== "summary" && "invisible")}>
                <PullRequestSummaryTab
                  environmentId={environmentId}
                  reference={reference}
                  detail={detail}
                  activityPending={activityPending}
                  activityError={activityError}
                  pendingFinding={handoff}
                  onFixFinding={startFixFinding}
                  onRefresh={refreshDetail}
                />
              </div>
            ) : null}
            {mountedTabs.has("timeline") ? (
              <div className={cn("absolute inset-0", tab !== "timeline" && "invisible")}>
                {activityPending ? (
                  <PullRequestTimelineGhost />
                ) : activityError ? (
                  <PullRequestActivityUnavailableState
                    error={activityError}
                    onRetry={activityQuery.refresh}
                  />
                ) : (
                  <PullRequestTimelineTab
                    detail={detail}
                    order={timelineOrder}
                    onOpenCommit={openCommit}
                  />
                )}
              </div>
            ) : null}
            {mountedTabs.has("code") ? (
              <div className={cn("absolute inset-0", tab !== "code" && "invisible")}>
                <Suspense fallback={<DiffPanelLoadingState label="Loading pull request diff..." />}>
                  <PullRequestCodeTab
                    onAskAboutSelection={askAboutSelection}
                    environmentId={environmentId}
                    reference={reference}
                    detail={detail}
                    selectedCommitOid={selectedCodeCommitOid}
                    onSelectedCommitChange={selectCodeCommit}
                    pendingFinding={handoff}
                    onFixFinding={startFixFinding}
                    onRefresh={refreshDetail}
                    refreshToken={refreshToken}
                  />
                </Suspense>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <AlertDialog
        open={confirmAction !== null}
        onOpenChange={(open) => !open && setConfirmAction(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "merge" ? "Merge pull request?" : "Close pull request?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "merge"
                ? `This merges #${reference.number} using ${selectedMergeMethod}.`
                : `This closes #${reference.number} without merging it.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant={confirmAction === "close" ? "destructive" : "default"}
              disabled={actionPending}
              onClick={() => {
                const action = confirmAction;
                setConfirmAction(null);
                if (action === "merge") void perform("merge", selectedMergeMethod);
                if (action === "close") void perform("close");
              }}
            >
              {confirmAction === "merge" ? "Merge" : "Close"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
