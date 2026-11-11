// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findAttachedImage } from "./tool-registry";
import { storeFile, removeFile } from "./file-store";
import { useMessageStore } from "../stores/messageStore";

describe("findAttachedImage", () => {
  it("모델이 적은 이름이 자모 분리·공백 종류가 달라도 같은 첨부를 찾는다", async () => {
    const name = "똑똑 병아리 1.png".normalize("NFD");
    const file = new File(["x"], name, { type: "image/png" });
    storeFile(file);
    expect(await findAttachedImage("똑똑 병아리 1.png")).toBe(file);
    removeFile(name);
  });

  it("앱을 다시 켜 원본이 없으면 대화에 남은 그림에서 꺼낸다", async () => {
    useMessageStore.getState().setAll({
      s: [{ id: "1", role: "user", content: "", time: "", attachments: [{ name: "cat.png", content: "", dataUrl: "data:image/png;base64,eA==", size: 1, type: "image/png" }] }],
    });
    const blob = await findAttachedImage("cat.png");
    expect(await blob?.text()).toBe("x");
    expect(await findAttachedImage("dog.png")).toBeNull();
  });
});
