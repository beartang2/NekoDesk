import { create } from "zustand";
import { DEFAULT_VARIANT_ID, getCatVariant } from "../cat/spriteData";

/**
 * 고양이 외형(스킨) 스토어 — Phase 4 첫 zustand 스토어(본보기).
 *
 * 예전엔 App.tsx 가 `catVariantId` 를 useState 로 들고, Sidebar 를 거쳐 CatCanvas 로,
 * SettingsModal 로 prop + onCatVariantChange 콜백으로 내려보냈다. 진짜 교차 상태라
 * 스토어가 맞다: CatCanvas 는 구독해서 그리고, SettingsModal 은 액션으로 바꾼다.
 * App.tsx 는 이 상태에서 완전히 손을 뗀다(prop-drilling 제거).
 *
 * localStorage 는 기존 키(raw 문자열)를 그대로 읽고 써서 데이터 마이그레이션이 없다.
 */

const STORAGE_KEY = "nekodesk_cat_variant";

interface CatStore {
  variantId: string;
  setVariant: (id: string) => void;
}

export const useCatStore = create<CatStore>((set) => ({
  variantId: getCatVariant(localStorage.getItem(STORAGE_KEY) ?? DEFAULT_VARIANT_ID).id,
  setVariant: (id) => {
    const valid = getCatVariant(id).id; // 알 수 없는 id 는 정규화
    localStorage.setItem(STORAGE_KEY, valid);
    set({ variantId: valid });
  },
}));
