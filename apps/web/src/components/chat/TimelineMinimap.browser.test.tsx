import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render, type Screen } from "../../../test/render";
import {
  minimapCanvas,
  minimapMarkerPixels,
  paintedMinimapMarkerIndices,
} from "../../../test/minimapPixels";
import {
  clearThemeInspectorHighlights,
  clearThemeInspectorHover,
  highlightThemeRoleUsage,
} from "../settings/themeInspector";
import { TimelineMinimap, type TimelineMinimapHandle } from "./TimelineMinimap";
import type { TimelineMinimapItem } from "./timelineMinimapItems";
import { forwardWheelToTimeline } from "./timelineMinimapWheel";

function items(count = 5, prefix = "turn"): TimelineMinimapItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    rowIndex: 1 + index * 4,
    userText: `Question ${prefix}-${index}`,
    assistantText: `Answer **${prefix}-${index}**`,
  }));
}

function minimap(
  ref: ReturnType<typeof createRef<TimelineMinimapHandle>>,
  turns: ReadonlyArray<TimelineMinimapItem>,
  onSelect: (item: TimelineMinimapItem) => void,
  key = "thread-a",
) {
  return (
    <div style={{ position: "relative", width: 600, height: 600 }}>
      <TimelineMinimap
        key={key}
        ref={ref}
        items={turns}
        hasPersistentGutter
        hitStripWidth={40}
        onSelect={onSelect}
        onWheel={() => {}}
      />
    </div>
  );
}

function rail(screen: Screen) {
  return screen.container.querySelector<HTMLButtonElement>(
    'button[aria-label^="Jump to message"]',
  )!;
}

function visible(
  ref: ReturnType<typeof createRef<TimelineMinimapHandle>>,
  start: number,
  end: number,
) {
  return act(() => ref.current!.updateVisibleRange(start, end));
}

async function withMinimapPalette(run: () => Promise<void>) {
  const root = document.documentElement;
  const originalStyle = root.getAttribute("style");
  try {
    // index.css maps these roles only after a real theme has been applied.
    root.style.setProperty("--foreground", "var(--app-theme-text)");
    root.style.setProperty("--muted-foreground", "var(--app-theme-muted-foreground)");
    root.style.setProperty("--app-theme-text", "#ff0000");
    root.style.setProperty("--app-theme-muted-foreground", "#0000ff");
    root.style.setProperty("--appearance-contrast-base", "100%");
    root.style.setProperty("--appearance-contrast-boost", "0%");
    await run();
  } finally {
    clearThemeInspectorHighlights();
    clearThemeInspectorHover();
    if (originalStyle === null) root.removeAttribute("style");
    else root.setAttribute("style", originalStyle);
  }
}

describe("TimelineMinimap", () => {
  it("highlights only visible user markers and navigates around the first visible turn", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    const turns = items();
    const onSelect = vi.fn();
    await using screen = await render(minimap(ref, turns, onSelect));
    await visible(ref, 5, 9);
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([1, 2]);

    await screen.getByRole("button", { name: "Previous turn" }).click();
    expect(onSelect).toHaveBeenLastCalledWith(turns[0]);
    await screen.getByRole("button", { name: "Next turn" }).click();
    expect(onSelect).toHaveBeenLastCalledWith(turns[2]);

    await visible(ref, 6, 8);
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([]);
    await screen.getByRole("button", { name: "Next turn" }).click();
    expect(onSelect).toHaveBeenLastCalledWith(turns[2]);

    await visible(ref, 17, 20);
    await expect.element(screen.getByRole("button", { name: "Next turn" })).toBeDisabled();
    await visible(ref, 0, 1);
    await expect.element(screen.getByRole("button", { name: "Previous turn" })).toBeDisabled();
  });

  it("keeps pointer previews, keyboard navigation, and endpoint geometry", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    const turns = items();
    const onSelect = vi.fn();
    await using screen = await render(minimap(ref, turns, onSelect));
    await visible(ref, 9, 9);
    const button = rail(screen);
    const bounds = button.getBoundingClientRect();
    await act(() => {
      button.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          clientY: bounds.top + bounds.height / 2,
        }),
      );
    });
    await expect.element(screen.getByText("Question turn-2", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Answer turn-2", { exact: true })).toBeVisible();
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([2]);
    expect(minimapMarkerPixels(screen.container, turns.length, 20)[2]![3]).toBeGreaterThan(200);

    await act(() => button.focus());
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: turns[3]!.id, rowIndex: turns[3]!.rowIndex }),
    );
    await userEvent.keyboard("{Home}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: turns[0]!.id, rowIndex: turns[0]!.rowIndex }),
    );
    await userEvent.keyboard("{End} ");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: turns[4]!.id, rowIndex: turns[4]!.rowIndex }),
    );
    await userEvent.keyboard("{ArrowUp}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: turns[3]!.id, rowIndex: turns[3]!.rowIndex }),
    );

    await act(() => {
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientY: bounds.top + bounds.height }),
      );
    });
    expect(onSelect).toHaveBeenLastCalledWith(turns[4]);
    await visible(ref, 1, 1);
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([0]);
    await visible(ref, 17, 17);
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([4]);
  });

  it("recomputes membership across row replacement, remounts, prepends and thread switches", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    const turns = items();
    const onSelect = vi.fn();
    await using screen = await render(minimap(ref, turns, onSelect));
    await visible(ref, 5, 9);
    const replacement = turns.map((turn) => ({ ...turn, rowIndex: turn.rowIndex + 1 }));
    await screen.rerender(minimap(ref, replacement, onSelect));
    // Same count, new row mapping, no imperative range update.
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([1]);

    await screen.rerender(minimap(ref, turns.slice(0, 1), onSelect));
    expect(screen.container.querySelector("[data-minimap-canvas]")).toBeNull();
    await screen.rerender(minimap(ref, turns, onSelect));
    expect(paintedMinimapMarkerIndices(screen.container, turns.length)).toEqual([1, 2]);
    await act(() => rail(screen).focus());

    const prepended = [
      { id: "earlier", rowIndex: 0, userText: "Earlier question", assistantText: null },
      ...turns.map((turn) => ({ ...turn, rowIndex: turn.rowIndex + 2 })),
    ];
    await screen.rerender(minimap(ref, prepended, onSelect));
    await visible(ref, 7, 11);
    expect(paintedMinimapMarkerIndices(screen.container, prepended.length)).toEqual([2, 3]);
    await screen.getByRole("button", { name: "Previous turn" }).click();
    expect(onSelect).toHaveBeenLastCalledWith(prepended[1]);
    await screen.getByRole("button", { name: "Next turn" }).click();
    expect(onSelect).toHaveBeenLastCalledWith(prepended[3]);

    await screen.rerender(minimap(ref, items(5, "other"), onSelect, "thread-b"));
    expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([]);
    expect(screen.container.querySelector("[data-minimap-preview]")).toBeNull();
    await expect.element(screen.getByRole("button", { name: "Previous turn" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Next turn" })).toBeDisabled();
    await visible(ref, 9, 9);
    expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);
    await screen.getByRole("button", { name: "Next turn" }).click();
    expect(onSelect).toHaveBeenLastCalledWith(items(5, "other")[3]);
  });

  it("retains the range across initial 0-to-1-to-2 items and a zero-size rail", async () => {
    await withMinimapPalette(async () => {
      const ref = createRef<TimelineMinimapHandle>();
      const turns = items(2);
      const onSelect = vi.fn();
      await using screen = await render(minimap(ref, [], onSelect));
      expect(screen.container.querySelector("[data-minimap-canvas]")).toBeNull();
      await visible(ref, 1, 5);
      await screen.rerender(minimap(ref, turns.slice(0, 1), onSelect));
      expect(screen.container.querySelector("[data-minimap-canvas]")).toBeNull();
      await screen.rerender(minimap(ref, turns, onSelect));
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 2)).toEqual([0, 1]);
      });
      const button = rail(screen);
      const bounds = button.getBoundingClientRect();
      expect(bounds.height).toBe(8);
      for (const [index, clientY] of [
        [0, bounds.top],
        [1, bounds.bottom],
      ] as const) {
        await act(() => {
          button.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY }));
        });
        expect(onSelect).toHaveBeenLastCalledWith(turns[index]);
      }

      await screen.rerender(minimap(ref, turns.slice(0, 1), onSelect));
      expect(screen.container.querySelector("[data-minimap-canvas]")).toBeNull();
      await screen.rerender(minimap(ref, turns, onSelect));
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 2)).toEqual([0, 1]);
      });
      const canvas = minimapCanvas(screen.container);
      const { width, height } = canvas.style;
      await act(() => {
        canvas.style.width = "0px";
        canvas.style.height = "0px";
      });
      await vi.waitFor(() => {
        expect(canvas.getBoundingClientRect().width).toBe(0);
        expect(canvas.getBoundingClientRect().height).toBe(0);
        expect(canvas.width).toBe(0);
        expect(canvas.height).toBe(0);
      });
      await act(() => {
        canvas.style.width = width;
        canvas.style.height = height;
      });
      // No range update since the empty render: resize must repaint retained rows.
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 2)).toEqual([0, 1]);
      });
      await expect.element(screen.getByRole("button", { name: "Previous turn" })).toBeDisabled();
      await expect.element(screen.getByRole("button", { name: "Next turn" })).toBeEnabled();
      await screen.getByRole("button", { name: "Next turn" }).click();
      expect(onSelect).toHaveBeenLastCalledWith(turns[1]);
    });
  });

  it("keeps focused previews and keyboard selection on the displayed replacement", async () => {
    await withMinimapPalette(async () => {
      const ref = createRef<TimelineMinimapHandle>();
      const onSelect = vi.fn();
      await using screen = await render(minimap(ref, items(), onSelect));
      await visible(ref, 9, 9);
      const button = rail(screen);
      // Fresh keyboard focus uses the moved viewport, with no pointer preview.
      await act(() => button.focus());
      await expect.element(screen.getByText("Question turn-2", { exact: true })).toBeVisible();
      const replacement = items(5, "replacement").map((turn) => ({
        ...turn,
        rowIndex: turn.rowIndex + 4,
      }));
      await screen.rerender(minimap(ref, replacement, onSelect));
      expect(document.activeElement).toBe(button);
      // Focus is index-based: index 2 now previews and selects the replacement ID.
      await expect
        .element(screen.getByText("Question replacement-2", { exact: true }))
        .toBeVisible();
      await expect.element(screen.getByText("Answer replacement-2", { exact: true })).toBeVisible();
      await expect
        .element(screen.getByText("Question turn-2", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(screen.getByText("Answer turn-2", { exact: true }))
        .not.toBeInTheDocument();
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([1]);
        expect(minimapMarkerPixels(screen.container, 5, 20).map((pixel) => pixel[3]! > 0)).toEqual([
          false,
          false,
          true,
          false,
          false,
        ]);
      });
      await userEvent.keyboard("{Enter}");
      expect(onSelect).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "replacement-2", rowIndex: 13 }),
      );
      const updated = replacement.map((turn, index) =>
        index === 2 ? { ...turn, assistantText: "Updated **replacement** answer" } : turn,
      );
      await screen.rerender(minimap(ref, updated, onSelect));
      await expect
        .element(screen.getByText("Updated replacement answer", { exact: true }))
        .toBeVisible();
      await expect
        .element(screen.getByText("Answer replacement-2", { exact: true }))
        .not.toBeInTheDocument();
      await userEvent.keyboard(" ");
      expect(onSelect).toHaveBeenLastCalledWith(
        expect.objectContaining({
          id: "replacement-2",
          rowIndex: 13,
          assistantText: "Updated replacement answer",
        }),
      );
      await screen.getByRole("button", { name: "Previous turn" }).click();
      expect(onSelect).toHaveBeenLastCalledWith(updated[0]);
      await screen.getByRole("button", { name: "Next turn" }).click();
      expect(onSelect).toHaveBeenLastCalledWith(updated[2]);

      await act(() => button.blur());
      expect(screen.container.querySelector("[data-minimap-preview]")).toBeNull();
      await visible(ref, 17, 17);
      await act(() => button.focus());
      await expect
        .element(screen.getByText("Question replacement-3", { exact: true }))
        .toBeVisible();
      await vi.waitFor(() => {
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([3]);
        expect(minimapMarkerPixels(screen.container, 5, 20)[3]![3]).toBeGreaterThan(200);
      });
      await userEvent.keyboard("{Enter}");
      expect(onSelect).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "replacement-3", rowIndex: 17 }),
      );
    });
  });

  it("clears highlight pixels and navigation for unknown bounds and restores the same range", async () => {
    await withMinimapPalette(async () => {
      const ref = createRef<TimelineMinimapHandle>();
      const turns = items();
      const onSelect = vi.fn();
      await using screen = await render(minimap(ref, turns, onSelect));
      await visible(ref, 9, 9);
      expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);
      for (const [start, end] of [
        [null, null],
        [null, 9],
        [9, null],
      ] as const) {
        await act(() => ref.current!.updateVisibleRange(start, end));
        await vi.waitFor(() => {
          expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([]);
          for (const pixel of minimapMarkerPixels(screen.container, 5)) {
            expect(pixel[2]).toBeGreaterThan(200);
            expect(pixel[3]).toBeGreaterThan(0);
            expect(pixel[3]).toBeLessThanOrEqual(191);
          }
        });
        await expect.element(screen.getByRole("button", { name: "Previous turn" })).toBeDisabled();
        await expect.element(screen.getByRole("button", { name: "Next turn" })).toBeDisabled();
        await visible(ref, 9, 9);
        await vi.waitFor(() => {
          expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);
        });
        await expect.element(screen.getByRole("button", { name: "Previous turn" })).toBeEnabled();
        await expect.element(screen.getByRole("button", { name: "Next turn" })).toBeEnabled();
        await screen.getByRole("button", { name: "Previous turn" }).click();
        expect(onSelect).toHaveBeenLastCalledWith(turns[1]);
        await screen.getByRole("button", { name: "Next turn" }).click();
        expect(onSelect).toHaveBeenLastCalledWith(turns[3]);
      }
    });
  });

  it("repaints an unchanged range after size and palette changes", async () => {
    await withMinimapPalette(async () => {
      const ref = createRef<TimelineMinimapHandle>();
      await using screen = await render(minimap(ref, items(), () => {}));
      await visible(ref, 9, 9);
      const canvas = minimapCanvas(screen.container);
      const before = minimapMarkerPixels(screen.container, 5);
      expect(before[2]![0]).toBeGreaterThan(200);
      expect(before[2]![3]).toBeGreaterThan(200);
      expect(before[0]![2]).toBeGreaterThan(200);
      expect(before[0]![3]).toBeLessThanOrEqual(191);
      expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);

      await act(() => {
        canvas.style.height = "66px";
      });
      await vi.waitFor(() => {
        expect(canvas.getBoundingClientRect().height).toBe(66);
        expect(canvas.height).toBe(Math.ceil(66 * (window.devicePixelRatio || 1)));
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);
      });

      await act(() => {
        document.documentElement.style.setProperty("--app-theme-text", "#00ff00");
        document.documentElement.style.setProperty("--app-theme-muted-foreground", "#ff0000");
      });
      await vi.waitFor(() => {
        const after = minimapMarkerPixels(screen.container, 5);
        expect(after[2]![1]).toBeGreaterThan(200);
        expect(after[0]![0]).toBeGreaterThan(200);
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([2]);
      });
    });
  });

  it("reports visible canvas usage synchronously and omits empty highlight paint", async () => {
    await withMinimapPalette(async () => {
      const MUTED = "mutedForeground";
      const FORE = "text";
      const matchAttribute = "data-theme-inspector-match";
      const ref = createRef<TimelineMinimapHandle>();
      await using screen = await render(minimap(ref, items(), () => {}));
      const canvas = minimapCanvas(screen.container);
      expect(canvas.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(canvas.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(getComputedStyle(canvas).display).not.toBe("none");

      await act(() => {
        // No await between range/probe/restore calls: the canvas theme observer
        // cannot run in the middle of this synchronous inspection.
        ref.current!.updateVisibleRange(5, 9);
        highlightThemeRoleUsage([MUTED]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(true);
        highlightThemeRoleUsage([FORE]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(true);

        ref.current!.updateVisibleRange(6, 8);
        highlightThemeRoleUsage([FORE]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(false);
        ref.current!.updateVisibleRange(null, null);
        highlightThemeRoleUsage([FORE]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(false);
        highlightThemeRoleUsage([MUTED]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(true);

        ref.current!.updateVisibleRange(9, 9);
        highlightThemeRoleUsage([FORE]);
        expect(canvas.hasAttribute(matchAttribute)).toBe(true);
      });
    });
  });

  it("repaints cleared backings when either canvas announces context restoration", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    const canvases: HTMLCanvasElement[] = [];
    const originalBeginPath = CanvasRenderingContext2D.prototype.beginPath;
    const contextCapture = vi
      .spyOn(CanvasRenderingContext2D.prototype, "beginPath")
      .mockImplementation(function (this: CanvasRenderingContext2D) {
        if (!canvases.includes(this.canvas)) canvases.push(this.canvas);
        originalBeginPath.call(this);
      });
    try {
      await using screen = await render(minimap(ref, items(), () => {}));
      contextCapture.mockRestore();
      await visible(ref, 5, 9);
      const canvas = minimapCanvas(screen.container);
      const base = canvases.find((candidate) => candidate !== canvas && !candidate.isConnected);
      expect(base).toBeDefined();
      const pixels = (target: HTMLCanvasElement) =>
        Array.from(target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data);
      const expectedDisplay = pixels(canvas);
      const expectedBase = pixels(base!);
      expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([1, 2]);

      for (const restored of [canvas, base!]) {
        await act(() => {
          for (const target of [canvas, base!]) {
            const width = target.width;
            target.width = width;
          }
          expect(pixels(canvas).every((value) => value === 0)).toBe(true);
          expect(pixels(base!).every((value) => value === 0)).toBe(true);
          // This models cleared pixels and reset drawing state. A synthetic
          // event does not prove real GPU loss or the browser's recovery policy.
          restored.dispatchEvent(new Event("contextrestored"));
        });
        expect(pixels(base!)).toEqual(expectedBase);
        expect(pixels(canvas)).toEqual(expectedDisplay);
        expect(paintedMinimapMarkerIndices(screen.container, 5)).toEqual([1, 2]);
      }
    } finally {
      contextCapture.mockRestore();
    }
  });

  it("lets an outside selection drag pass through and restores the hit target on release", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    await using screen = await render(minimap(ref, items(), () => {}));
    const hitTarget = rail(screen).parentElement!;
    await act(() => {
      hitTarget.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, buttons: 1 }));
    });
    expect(getComputedStyle(hitTarget).pointerEvents).toBe("none");
    await act(() => {
      window.dispatchEvent(new MouseEvent("mouseup", { buttons: 0 }));
    });
    expect(getComputedStyle(hitTarget).pointerEvents).toBe("auto");
  });

  it("forwards wheel scrolling from the rail to the timeline", async () => {
    const ref = createRef<TimelineMinimapHandle>();
    const viewport = createRef<HTMLDivElement>();
    await using screen = await render(
      <div style={{ position: "relative", width: 600, height: 600 }}>
        <div ref={viewport} style={{ height: 100, overflow: "auto" }}>
          <div style={{ height: 2_000 }} />
        </div>
        <TimelineMinimap
          ref={ref}
          items={items()}
          hasPersistentGutter
          hitStripWidth={40}
          onSelect={() => {}}
          onWheel={(event) => forwardWheelToTimeline(event, viewport.current!)}
        />
      </div>,
    );
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 80 });
    await act(() => {
      rail(screen).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(viewport.current!.scrollTop).toBe(80);
  });
});
