import { ComposerContextId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { encodeComposerContextFragment } from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
  rewritePastedPullRequestMarkers,
  selfConsistentPastedPullRequestNumber,
} from "@t3tools/shared/composerContextReferences";
import { ComposerEditor as NativeComposerEditor } from "../native/T3ComposerEditor";
import type { ComposerEditorProps as NativeComposerEditorProps } from "../native/T3ComposerEditor";
import {
  appendComposerDraftAttachments,
  createComposerDraftContextHistory,
  getComposerDraftAfterSelection,
  getComposerDraftSnapshot,
  insertComposerDraftContext,
  insertComposerDraftText,
  rememberComposerDraftSelection,
  setComposerDraftContext,
  setComposerDraftText,
  setComposerContextImporting,
  useComposerDraft,
} from "../state/use-composer-drafts";
import { importComposerContextClipboard } from "../lib/composerContextClipboard";
import { pullRequestComposerContext } from "../lib/composerContext";
import { pendingPastedPullRequestRecords } from "../lib/pastedPullRequestContext";
import { composerPullRequests } from "../state/pull-requests";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { mobilePreferencesAtom } from "../state/preferences";
import { ComposerContextSheet } from "./ComposerContextSheet";
import { AppText as Text } from "./AppText";
import {
  composerDocumentAttachment,
  composerMentionPath,
  type ComposerDocumentAttachment,
} from "../lib/composerContext";

export type ComposerEditorProps = NativeComposerEditorProps & {
  readonly draftKey?: string | null;
  readonly environmentId?: EnvironmentId;
  readonly pullRequestProjectId?: ProjectId | null;
  readonly pullRequestRepository?: string | null;
  readonly onOpenMention?: (path: string) => void;
  /** Documents open in the file screen; pictures, video and PDF keep their native viewers. */
  readonly onOpenAttachment?: (attachment: ComposerDocumentAttachment) => void;
  /**
   * A resting composer is a target to type in, not a document to navigate. Its chips go inert
   * so a draft full of them can still be tapped anywhere to start writing; the caller focuses
   * the editor instead. Chips become live again once the composer is open.
   */
  readonly chipsInert?: boolean;
  /** Called instead of opening a chip while `chipsInert` is set. */
  readonly onInertChipPress?: () => void;
};

export function ComposerEditor({
  draftKey,
  environmentId,
  pullRequestProjectId,
  pullRequestRepository,
  onOpenMention,
  onOpenAttachment,
  chipsInert,
  onInertChipPress,
  ...props
}: ComposerEditorProps) {
  const draft = useComposerDraft(draftKey ?? null);
  const readPastedPullRequestDetail = useAtomQueryRunner(composerPullRequests.detail, {
    reportFailure: false,
    reportDefect: false,
  });
  const pullRequestScope =
    draftKey && environmentId && pullRequestProjectId && pullRequestRepository
      ? JSON.stringify([draftKey, environmentId, pullRequestProjectId, pullRequestRepository])
      : null;
  const pullRequestScopeRef = useRef(pullRequestScope);
  pullRequestScopeRef.current = pullRequestScope;
  useEffect(() => {
    pullRequestScopeRef.current = pullRequestScope;
    return () => {
      pullRequestScopeRef.current = null;
    };
  }, [pullRequestScope]);
  const pendingPullRequestLookupsRef = useRef(new Set<string>());
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const preferredEnterBehavior = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.composerEnterBehavior
    : undefined;
  const contextHistory = useMemo(() => createComposerDraftContextHistory(), [draftKey]);
  useEffect(() => () => contextHistory.dispose(), [contextHistory]);
  const changeText = (text: string) => {
    const restored = contextHistory.restore(
      text,
      draftKey ? getComposerDraftSnapshot(draftKey) : draft,
    );
    props.onChangeText(text);
    if (draftKey) {
      setComposerDraftContext(draftKey, restored.context);
      appendComposerDraftAttachments(draftKey, restored.attachments, { allowOverflow: true });
    }
  };
  const [selected, setSelected] = useState<{ source: string; start: number; end: number } | null>(
    null,
  );
  const importRef = useRef<AbortController | null>(null);
  const [importing, setImporting] = useState(false);
  useEffect(
    () => () => {
      importRef.current?.abort();
      if (pendingPullRequestLookupsRef.current.size > 0 && draftKey) {
        pendingPullRequestLookupsRef.current.clear();
        setComposerContextImporting(draftKey, false);
      }
    },
    [draftKey],
  );
  const pasteContext = async (
    clipboard: Parameters<NonNullable<NativeComposerEditorProps["onPasteContext"]>>[0],
  ) => {
    if (!draftKey || importRef.current || props.readOnly || props.editable === false) return;
    const insertion = { text: clipboard.value, ...clipboard.selection };
    const pastedText = pullRequestScope
      ? rewritePastedPullRequestMarkers(clipboard.text)
      : clipboard.text;
    const controller = new AbortController();
    importRef.current = controller;
    setImporting(true);
    setComposerContextImporting(draftKey, true);
    try {
      const retained = getComposerDraftAfterSelection(draftKey, insertion);
      const result = await importComposerContextClipboard(
        { ...clipboard, text: pastedText },
        retained.attachments.length,
        controller.signal,
        retained.context?.records.length ?? 0,
      );
      const text = result?.text ?? pastedText;
      const importedRecords = result?.context.records ?? [];
      const pendingRecords = pullRequestScope
        ? pendingPastedPullRequestRecords(text, importedRecords)
        : [];
      if (!result && pendingRecords.length === 0) {
        insertComposerDraftText(draftKey, text, insertion);
        return;
      }
      if (
        !insertComposerDraftContext(
          draftKey,
          {
            text,
            context: { version: 1, records: [...importedRecords, ...pendingRecords] },
            attachments: result?.attachments,
          },
          insertion,
        )
      ) {
        Alert.alert(
          "Could not paste context",
          "Remove some attachments or context items from the draft, then paste again.",
        );
        return;
      }
      if (result && result.failures.length > 0)
        Alert.alert(
          "Some attachments could not be copied",
          "Reconnect to the source environment and copy them again. References without their files are marked unavailable.",
        );
    } catch (error) {
      if (!controller.signal.aborted)
        Alert.alert(
          "Could not paste context",
          error instanceof Error ? error.message : "Try copying again.",
        );
    } finally {
      setComposerContextImporting(draftKey, false);
      importRef.current = null;
      setImporting(false);
    }
  };
  useEffect(() => {
    if (!draftKey || !pullRequestScope || importRef.current) return;
    const rewritten = rewritePastedPullRequestMarkers(draft.text);
    const pending = pendingPastedPullRequestRecords(rewritten, draft.context?.records ?? []);
    if (rewritten !== draft.text) setComposerDraftText(draftKey, rewritten);
    if (pending.length > 0) {
      setComposerDraftContext(draftKey, {
        version: 1,
        records: [...(draft.context?.records ?? []), ...pending],
      });
    }
  }, [draftKey, draft.text, draft.context, pullRequestScope, importing]);
  useEffect(() => {
    if (
      !draftKey ||
      !pullRequestScope ||
      !environmentId ||
      !pullRequestProjectId ||
      !pullRequestRepository
    ) {
      if (pendingPullRequestLookupsRef.current.size > 0) {
        pendingPullRequestLookupsRef.current.clear();
        if (draftKey) setComposerContextImporting(draftKey, false);
      }
      return;
    }
    if (importRef.current) return;
    for (const key of pendingPullRequestLookupsRef.current) {
      if (key.startsWith(`${pullRequestScope}:`)) continue;
      pendingPullRequestLookupsRef.current.delete(key);
    }
    const unresolved = collectComposerContextReferences(draft.text).flatMap((reference) => {
      const number = selfConsistentPastedPullRequestNumber(reference.label, reference.contextId);
      if (number === null) return [];
      const record = draft.context?.records.find(
        (entry) => entry.contextId === reference.contextId,
      );
      return record?.kind === "review-comment" && "pullRequest" in record && !record.pullRequest
        ? [{ number, contextId: reference.contextId }]
        : [];
    });
    if (unresolved.length === 0) {
      if (pendingPullRequestLookupsRef.current.size > 0) {
        pendingPullRequestLookupsRef.current.clear();
        setComposerContextImporting(draftKey, false);
      }
      return;
    }
    for (const { number } of unresolved) {
      const lookupKey = `${pullRequestScope}:${number}`;
      if (pendingPullRequestLookupsRef.current.has(lookupKey)) continue;
      pendingPullRequestLookupsRef.current.add(lookupKey);
      setComposerContextImporting(draftKey, true);
      let deadline: ReturnType<typeof setTimeout>;
      void Promise.race([
        readPastedPullRequestDetail({
          environmentId,
          input: { projectId: pullRequestProjectId, repository: pullRequestRepository, number },
        }),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error("PR lookup timed out")), 30_000);
        }),
      ])
        .then((result) => {
          if (pullRequestScopeRef.current !== pullRequestScope) return;
          if (result._tag !== "Success") throw new Error("PR lookup failed");
          const latest = getComposerDraftSnapshot(draftKey);
          const pendingIds = new Set(
            collectComposerContextReferences(latest.text)
              .filter(
                (reference) =>
                  selfConsistentPastedPullRequestNumber(reference.label, reference.contextId) ===
                  number,
              )
              .map((reference) => reference.contextId),
          );
          if (!latest.context || pendingIds.size === 0) return;
          setComposerDraftContext(draftKey, {
            version: 1,
            records: latest.context.records.map((record) =>
              pendingIds.has(record.contextId) &&
              record.kind === "review-comment" &&
              "pullRequest" in record &&
              !record.pullRequest
                ? pullRequestComposerContext(result.value, record.contextId)
                : record,
            ),
          });
        })
        .catch(() => {
          if (pullRequestScopeRef.current !== pullRequestScope) return;
          const latest = getComposerDraftSnapshot(draftKey);
          const pendingIds = new Set(
            collectComposerContextReferences(latest.text)
              .filter(
                (reference) =>
                  selfConsistentPastedPullRequestNumber(reference.label, reference.contextId) ===
                    number &&
                  latest.context?.records.some(
                    (record) =>
                      record.contextId === reference.contextId &&
                      record.kind === "review-comment" &&
                      "pullRequest" in record &&
                      !record.pullRequest,
                  ),
              )
              .map((reference) => reference.contextId),
          );
          if (pendingIds.size === 0) return;
          setComposerDraftText(
            draftKey,
            replaceComposerContextReferences(latest.text, (reference) =>
              pendingIds.has(reference.contextId) ? reference.label : reference.source,
            ),
          );
          Alert.alert(`Could not load PR #${number}`, "The number is still in your message.");
        })
        .finally(() => {
          clearTimeout(deadline);
          pendingPullRequestLookupsRef.current.delete(lookupKey);
          if (
            pullRequestScopeRef.current === pullRequestScope &&
            pendingPullRequestLookupsRef.current.size === 0
          ) {
            setComposerContextImporting(draftKey, false);
          }
        });
    }
  }, [
    draftKey,
    draft.text,
    draft.context,
    environmentId,
    pullRequestProjectId,
    pullRequestRepository,
    pullRequestScope,
    importing,
    readPastedPullRequestDetail,
  ]);
  const clipboardFragment = useMemo(
    () =>
      environmentId && draft.context
        ? encodeComposerContextFragment({
            version: 1,
            source: { environmentId },
            records: draft.context.records.map((record) => {
              if (!("attachmentId" in record)) return record;
              const attachment = draft.attachments.find(
                (entry) => entry.id === record.attachmentId,
              );
              return {
                ...record,
                attachmentId:
                  attachment?.uploadEnvironmentId === environmentId
                    ? (attachment.uploadedAttachmentId ?? record.attachmentId)
                    : record.attachmentId,
              };
            }),
          })
        : "",
    [environmentId, draft.context, draft.attachments],
  );
  const selectedReference = selected
    ? collectComposerContextReferences(selected.source)[0]
    : undefined;
  const selectedSkillName = selected?.source.match(/^\p{Sc}(.+)$/u)?.[1];
  const selectedSkill = selectedSkillName
    ? props.skills?.find((skill) => skill.name === selectedSkillName)
    : undefined;
  const record = draft.context?.records.find(
    (entry) => entry.contextId === selectedReference?.contextId,
  );
  return (
    <>
      <NativeComposerEditor
        {...props}
        enterBehavior={props.enterBehavior ?? preferredEnterBehavior}
        onChangeText={changeText}
        readOnly={props.readOnly || importing}
        onSubmit={importing ? undefined : props.onSubmit}
        clipboardFragment={clipboardFragment ?? undefined}
        onPasteContext={(clipboard) => void pasteContext(clipboard)}
        context={draft.context}
        pendingPullRequestResolvable={pullRequestScope !== null}
        onContextPress={(selection) => {
          if (chipsInert) {
            onInertChipPress?.();
            return;
          }
          const path = composerMentionPath(selection.source, draft.context);
          if (path && onOpenMention) {
            onOpenMention(path);
            return;
          }
          const document = composerDocumentAttachment(selection.source, draft.context);
          if (document && onOpenAttachment) {
            onOpenAttachment(document);
            return;
          }
          setSelected(selection);
        }}
        onSelectionChange={(selection) => {
          if (draftKey)
            rememberComposerDraftSelection(
              draftKey,
              getComposerDraftSnapshot(draftKey).text,
              selection,
            );
          props.onSelectionChange?.(selection);
        }}
      />
      {importing ? (
        <Text className="py-2 text-xs text-foreground-muted">Copying context…</Text>
      ) : null}
      {selected && (selectedReference || selectedSkill) ? (
        <ComposerContextSheet
          label={
            selectedReference?.label ?? selectedSkill?.displayName ?? selectedSkill?.name ?? "Skill"
          }
          record={
            record ??
            (selectedSkill
              ? {
                  version: 1,
                  kind: "skill",
                  contextId: ComposerContextId.make("skill-preview"),
                  label: selectedSkill.name,
                  name: selectedSkill.name,
                }
              : undefined)
          }
          {...(selectedSkill?.description ? { skillDescription: selectedSkill.description } : {})}
          {...(selectedSkill?.path && onOpenMention
            ? {
                onOpenSkill: () => {
                  setSelected(null);
                  onOpenMention(selectedSkill.path!);
                },
              }
            : {})}
          environmentId={environmentId}
          records={draft.context?.records}
          attachments={draft.attachments}
          onClose={() => setSelected(null)}
          onRemove={
            props.readOnly || props.editable === false
              ? undefined
              : () => {
                  if (props.value.slice(selected.start, selected.end) === selected.source) {
                    changeText(
                      props.value.slice(0, selected.start) + props.value.slice(selected.end),
                    );
                    props.onSelectionChange?.({ start: selected.start, end: selected.start });
                  }
                  setSelected(null);
                }
          }
        />
      ) : null}
    </>
  );
}
export type {
  ComposerEditorHandle,
  ComposerEditorSelection,
  ComposerTextPaste,
} from "../native/T3ComposerEditor";
