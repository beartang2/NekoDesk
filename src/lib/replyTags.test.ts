import { describe, it, expect } from "vitest";
import { PET_STATE_RE, cleanShownText, stripPetState, stripThink } from "./replyTags";

describe("모델 답 태그 떼기(채팅·선물·가구 같은 함수)", () => {
  it("감정·생각 태그를 떼고 끝 빈칸·줄바꿈을 다듬는다", () => {
    const body = "동그라미 하나에 곡선 몇 줄, 풀린 실 한 가닥 그렸어. 액자에 넣어서 줄게! [[PET_STATE:happy]]";
    expect(cleanShownText(body)).toBe("동그라미 하나에 곡선 몇 줄, 풀린 실 한 가닥 그렸어. 액자에 넣어서 줄게!");
    expect(cleanShownText("<think>뭘 줄까</think>\n털실 공이야  \n[[PET_STATE:proud]]\n")).toBe("털실 공이야");
    expect(cleanShownText("반쯤 <think>아직 생각 중")).toBe("반쯤");
    expect(cleanShownText("그냥 글")).toBe("그냥 글");
  });
  it("채팅 쪽 조각도 같다", () => {
    expect("끝 [[PET_STATE:curious]]".match(PET_STATE_RE)?.[1]).toBe("curious");
    expect(stripPetState("a[[PET_STATE:idle]]b[[PET_STATE:happy]]")).toBe("ab");
    expect(stripThink("<think>x</think>답")).toBe("답");
  });
});
