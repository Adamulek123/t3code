import { describe, expect, it, vi } from "vite-plus/test";

import {
  resolveTerminalSelectionActionPosition,
  runTerminalMenuRequest,
  shouldHandleTerminalExit,
  shouldHandleTerminalSelectionMouseUp,
  shouldRestoreTerminalFocusAfterMenuAction,
  terminalContextMenuItems,
  terminalSelectionActionDelayForClickCount,
  terminalSelectionLineRange,
} from "./ThreadTerminalDrawer";

describe("runTerminalMenuRequest", () => {
  it("drops an action when the menu owner aborts before it resolves", async () => {
    const abortController = new AbortController();
    let resolveMenu: (action: "copy") => void = () => {};
    const open = vi.fn(
      () =>
        new Promise<"copy">((resolve) => {
          resolveMenu = resolve;
        }),
    );
    const perform = vi.fn(async () => {});
    const reportOpenError = vi.fn();
    const focusTerminal = vi.fn();
    const request = runTerminalMenuRequest({
      signal: abortController.signal,
      isCurrentRequest: () => true,
      open,
      perform,
      reportOpenError,
      focusTerminal,
    });

    abortController.abort();
    resolveMenu("copy");
    await request;

    expect(perform).not.toHaveBeenCalled();
    expect(reportOpenError).not.toHaveBeenCalled();
    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it("does not restore focus when teardown aborts an action in flight", async () => {
    const abortController = new AbortController();
    let finishAction: () => void = () => {};
    const perform = vi.fn(
      (_action: "add-to-chat" | "copy" | "paste", isCurrent: () => boolean) =>
        new Promise<void>((resolve) => {
          expect(isCurrent()).toBe(true);
          finishAction = () => {
            expect(isCurrent()).toBe(false);
            resolve();
          };
        }),
    );
    const focusTerminal = vi.fn();
    const request = runTerminalMenuRequest({
      signal: abortController.signal,
      isCurrentRequest: () => true,
      open: async () => "copy",
      perform,
      reportOpenError: vi.fn(),
      focusTerminal,
    });
    await vi.waitFor(() => expect(perform).toHaveBeenCalledOnce());

    abortController.abort();
    finishAction();
    await request;

    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it("suppresses a rejection from a superseded menu request", async () => {
    const reportOpenError = vi.fn();

    await runTerminalMenuRequest({
      signal: new AbortController().signal,
      isCurrentRequest: () => false,
      open: () => Promise.reject(new Error("stale menu failure")),
      perform: vi.fn(async () => {}),
      reportOpenError,
      focusTerminal: vi.fn(),
    });

    expect(reportOpenError).not.toHaveBeenCalled();
  });

  it("reports a failure from the current menu request", async () => {
    const error = new Error("menu failed");
    const reportOpenError = vi.fn();

    await runTerminalMenuRequest({
      signal: new AbortController().signal,
      isCurrentRequest: () => true,
      open: () => Promise.reject(error),
      perform: vi.fn(async () => {}),
      reportOpenError,
      focusTerminal: vi.fn(),
    });

    expect(reportOpenError).toHaveBeenCalledWith(error);
  });

  it("does nothing when the menu is dismissed without an action", async () => {
    const perform = vi.fn(async () => {});
    const focusTerminal = vi.fn();

    await runTerminalMenuRequest({
      signal: new AbortController().signal,
      isCurrentRequest: () => true,
      open: async () => null,
      perform,
      reportOpenError: vi.fn(),
      focusTerminal,
    });

    expect(perform).not.toHaveBeenCalled();
    expect(focusTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ["copy", true],
    ["paste", true],
    ["add-to-chat", false],
  ] as const)("performs %s and restores focus only when required", async (action, shouldFocus) => {
    const perform = vi.fn(async () => {});
    const focusTerminal = vi.fn();

    await runTerminalMenuRequest({
      signal: new AbortController().signal,
      isCurrentRequest: () => true,
      open: async () => action,
      perform,
      reportOpenError: vi.fn(),
      focusTerminal,
    });

    expect(perform).toHaveBeenCalledWith(action, expect.any(Function));
    expect(focusTerminal).toHaveBeenCalledTimes(shouldFocus ? 1 : 0);
  });
});

describe("shouldRestoreTerminalFocusAfterMenuAction", () => {
  it("restores focus only after terminal-local actions", () => {
    expect(shouldRestoreTerminalFocusAfterMenuAction("copy")).toBe(true);
    expect(shouldRestoreTerminalFocusAfterMenuAction("paste")).toBe(true);
    expect(shouldRestoreTerminalFocusAfterMenuAction("add-to-chat")).toBe(false);
    expect(shouldRestoreTerminalFocusAfterMenuAction(null)).toBe(false);
  });
});

describe("terminalContextMenuItems", () => {
  it("offers terminal actions and disables selection-only actions without a selection", () => {
    expect(terminalContextMenuItems({ canAddToChat: false, canCopy: false }, "Win32")).toEqual([
      { id: "add-to-chat", label: "Add to chat", disabled: true },
      { id: "copy", label: "Copy", accelerator: "Ctrl+Shift+C", disabled: true },
      { id: "paste", label: "Paste", accelerator: "Ctrl+Shift+V" },
    ]);
  });

  it("enables copy and add to chat when terminal text is selected", () => {
    expect(terminalContextMenuItems({ canAddToChat: true, canCopy: true }, "Win32")).toEqual([
      { id: "add-to-chat", label: "Add to chat", disabled: false },
      { id: "copy", label: "Copy", accelerator: "Ctrl+Shift+C", disabled: false },
      { id: "paste", label: "Paste", accelerator: "Ctrl+Shift+V" },
    ]);
  });

  it("keeps Copy enabled for selections that cannot be added to chat", () => {
    expect(terminalContextMenuItems({ canAddToChat: false, canCopy: true }, "Win32")).toEqual([
      { id: "add-to-chat", label: "Add to chat", disabled: true },
      { id: "copy", label: "Copy", accelerator: "Ctrl+Shift+C", disabled: false },
      { id: "paste", label: "Paste", accelerator: "Ctrl+Shift+V" },
    ]);
  });

  it("uses native Command shortcuts on macOS", () => {
    expect(terminalContextMenuItems({ canAddToChat: true, canCopy: true }, "MacIntel")).toEqual([
      { id: "add-to-chat", label: "Add to chat", disabled: false },
      { id: "copy", label: "Copy", accelerator: "Command+C", disabled: false },
      { id: "paste", label: "Paste", accelerator: "Command+V" },
    ]);
  });
});

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });

  it("uses Ghostty's physical screen range for visually wrapped selections", () => {
    expect(
      terminalSelectionLineRange({
        start: { y: 4 },
        end: { y: 6 },
      }),
    ).toEqual({ lineStart: 5, lineEnd: 7 });
  });

  it("handles an exit that lands while the terminal surface is still loading", () => {
    expect(shouldHandleTerminalExit("exited", "running", false)).toBe(true);
    expect(shouldHandleTerminalExit("exited", "exited", false)).toBe(false);
    expect(shouldHandleTerminalExit("closed", "running", true)).toBe(false);
  });
});
