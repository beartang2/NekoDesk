/** 날씨 창문 자리(무대 px). 방(sidebar)·거실(dock)만, 마당은 null */
export function roomWindow(
  place: "sidebar" | "dock" | "screen",
  W: number,
  H: number,
): { x: number; y: number; w: number; h: number } | null;
