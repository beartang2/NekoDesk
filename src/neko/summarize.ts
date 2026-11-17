import type { NekoAppearance } from "./engine/neko-engine";

/** 지금 모습을 한 줄로: "크림 · 줄무늬 · 노란 눈 · 단모 · 보통 체형" */
const COAT_NAME: Record<NekoAppearance["coat"], string> = { black: "까망", cheese: "치즈", gray: "회색", cream: "크림", white: "하양", custom: "직접 고른 색" };
const PATTERN_NAME = { white: "흰 반점", calico: "삼색", tabby: "줄무늬", point: "포인트" } as const;
const EYE_NAME = { yellow: "노란", white: "하얀", green: "연두", blue: "파란" } as const;
const FUR_NAME = { short: "단모", medium: "중모", long: "장모" } as const;
const BUILD_NAME = { slim: "날씬", normal: "보통 체형", chubby: "통통" } as const;

export function summarizeAppearance(a: NekoAppearance): string {
  return [COAT_NAME[a.coat], ...a.patterns.map((p) => PATTERN_NAME[p]), `${EYE_NAME[a.eye]} 눈`, FUR_NAME[a.fur], BUILD_NAME[a.build]].join(" · ");
}

/** 털 색 견본(직접 고른 색이면 그 색) */
export const COAT_SWATCH: Record<Exclude<NekoAppearance["coat"], "custom">, string> = {
  black: "#161418", cheese: "#e2984a", gray: "#8f8b98", cream: "#ead2ac", white: "#f2efe9",
};
export const coatSwatch = (a: NekoAppearance) => (a.coat === "custom" ? a.color : COAT_SWATCH[a.coat]);
