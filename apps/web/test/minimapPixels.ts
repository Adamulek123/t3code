export function minimapCanvas(container: ParentNode) {
  const canvas = container.querySelector<HTMLCanvasElement>("[data-minimap-canvas]");
  if (!canvas) throw new Error("Missing minimap canvas");
  return canvas;
}

/** Sample sparse marker centers, clear of round caps and adjacent ticks. */
export function minimapMarkerPixels(container: ParentNode, count: number, railX = 4) {
  const canvas = minimapCanvas(container);
  const bounds = canvas.getBoundingClientRect();
  const context = canvas.getContext("2d");
  if (!context || bounds.width <= 0 || bounds.height <= 0 || !canvas.width || !canvas.height) {
    throw new Error("Minimap has no drawable backing");
  }
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  // The canvas adds one CSS pixel around the rail. Use the actual backing ratio
  // rather than assuming DPR is integral or that its dimensions round exactly.
  const x = Math.floor(((1 + railX) / bounds.width) * canvas.width);
  return Array.from({ length: count }, (_, index) => {
    const railY = count <= 1 ? 0 : (index / (count - 1)) * (bounds.height - 2);
    const y = Math.floor(((1 + railY) / bounds.height) * canvas.height);
    const offset = (y * canvas.width + x) * 4;
    return Array.from(data.subarray(offset, offset + 4));
  });
}

export function paintedMinimapMarkerIndices(container: ParentNode, count: number) {
  // Base alpha is 35%, active alpha is 75% (at most about 191). The 90%
  // highlight over either exceeds 200. Callers use sparse markers to avoid
  // antialiased overlap admitting an unselected neighbor.
  return minimapMarkerPixels(container, count).flatMap((pixel, index) =>
    pixel[3]! > 200 ? [index] : [],
  );
}
