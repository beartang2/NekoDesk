export type RoomWindowRect = { x: number; y: number; w: number; h: number };
/** 날씨 창문 자리들(무대 px). 방(sidebar)은 하나, 거실(dock)은 나란히 둘, 마당은 빈 배열 */
export function roomWindows(place: "sidebar" | "dock" | "screen", W: number, H: number): RoomWindowRect[];
/** 창문 하나(거실이면 왼쪽 것). 마당이면 null */
export function roomWindow(place: "sidebar" | "dock" | "screen", W: number, H: number): RoomWindowRect | null;
