# 그림 그리기

도형을 쌓은 그림이 아니라 일러스트레이터가 그린 듯한 부드러운 벡터 그림을 목표로 한다.
**SVG** 로 그리고, 저장한 결과를 **직접 보고 고친다.** 코드 실행으로 그림 파일이 생기면
다음 차례에 그 그림이 이미지로 너에게 보인다.

## 그리기 전에 정할 것

1. **구도** — 주인공이 무엇이고 화면의 몇 %(보통 55~70%)를 차지하는지, 어디를 보는지.
2. **광원** — 보통 왼쪽 위. 이후의 밝은 면·그림자·하이라이트가 전부 이 방향을 따른다.
3. **팔레트** — 주색 2~3개 + 중립색 1~2개. 색마다 세 단계를 미리 정해라:
   하이라이트(더 밝고 따뜻하게) · 기본 · 그림자(더 어둡고 살짝 차갑게, 채도는 약간 올려).
   순검정·원색(#000, #FF0000)은 쓰지 마라. 가장 어두운 색은 남색·고동색 계열로.

## 기법

- **실루엣은 path 로.** 머리·몸·귀·꼬리처럼 유기적인 형태는 cubic Bézier(`C`·`S`)로 이은
  닫힌 path 하나로 그려라. 원·타원을 겹쳐 붙이면 이음매가 생겨 장난감처럼 보인다.
  점은 적게, 곡선은 매끈하게(이웃한 제어점이 한 직선 위에 오게).
- **명암 3단.** 기본 면은 `radialGradient` 로(fx·fy 를 광원 쪽에), 그림자 면은 광원 반대편에
  얹고 `clipPath` 로 본체 안에 가둔다, 하이라이트는 광원 쪽에 작게 — 흐림(blur) 필터와
  opacity 0.4~0.6 을 주면 유리구슬처럼 번들거리지 않는다.
- **바닥 그림자.** 주인공 아래 납작한 타원 + `feGaussianBlur`(stdDeviation 10~20), opacity 0.15~0.25.
  이것 하나로 그림이 땅에 선다.
- **선.** 외곽선은 검정이 아니라 그 면의 그림자색보다 더 어두운 같은 계열색. 바깥 5~8,
  안쪽 디테일 3~5, `stroke-linecap/linejoin="round"`. 선 없이 면만으로 가도 좋다 — 한 그림 안에선 통일.
- **얼굴·디테일.** 눈엔 흰 반사광 두 개(큰 것·작은 것), 볼터치는 가장자리가 사라지는
  radialGradient. 디테일은 큰 면이 다 자리 잡은 뒤에 얹어라.
- **배경.** 단색 대신 은은한 `linearGradient` + 크고 흐린 형태 두세 개로 깊이를 준다.
  주인공보다 채도·대비를 낮춰 주인공이 먼저 보이게.
- **대칭.** 반쪽만 그리고 `<g transform="translate(1024 0) scale(-1 1)">` 안에 `<use>` 로 뒤집어라.

## SVG 규칙

- `viewBox="0 0 1024 1024" width="1024" height="1024"`. 세밀한 곡선에 여유가 있다.
- 배경을 맨 먼저 깔아라. 투명 배경은 어둡게 보인다.
- gradient·filter·clipPath·재사용 path 는 `<defs>` 에 모으고 id 가 겹치지 않게.
- filter 는 그림자·하이라이트·배경 흐림에만. 남발하면 그림 전체가 뿌옇다.
- `<text>` 는 꼭 필요할 때만 — 글꼴이 환경마다 다르다.
- 상대 경로로 저장하면 출력 폴더(~/.nekodesk/output)에 모인다.

## 보고 고치기

저장한 그림이 보이면 아래를 확인하고, 고칠 게 있으면 **그 부분만** 고쳐 다시 저장해라.

- 형태: 비율·대칭·이음매가 의도대로인가. 뭔가 빠지거나 잘리지 않았나.
- 명암: 밝은 면과 그림자가 한 광원을 따르는가. 하이라이트가 과하지 않은가.
- 색: 탁하거나 너무 쨍하지 않은가. 주인공이 배경에서 분리돼 보이는가.

두 번 다듬어도 더 나아지지 않으면 거기서 멈추고 결과를 보여 줘라.

## 예시 — 고양이 얼굴 (기법 참고용, 그대로 베끼지 마라)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#CFE6F5"/>
      <stop offset="1" stop-color="#F7EFE4"/>
    </linearGradient>
    <radialGradient id="fur" cx="0.42" cy="0.40" r="0.70" fx="0.30" fy="0.26">
      <stop offset="0" stop-color="#FFCB94"/>
      <stop offset="0.55" stop-color="#F4A259"/>
      <stop offset="1" stop-color="#D8823F"/>
    </radialGradient>
    <radialGradient id="blush">
      <stop offset="0" stop-color="#F28B8B" stop-opacity="0.6"/>
      <stop offset="1" stop-color="#F28B8B" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="16"/>
    </filter>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
    <path id="head" d="M512 300 C672 300 780 400 780 540 C780 690 660 790 512 790 C364 790 244 690 244 540 C244 400 352 300 512 300 Z"/>
    <clipPath id="inHead"><use href="#head"/></clipPath>
    <path id="ear" d="M300 430 C286 330 300 230 336 176 C400 206 456 262 486 320 C420 330 352 370 300 430 Z"/>
    <path id="earIn" d="M330 380 C326 316 336 262 356 232 C392 256 422 290 440 322 C398 334 362 352 330 380 Z"/>
  </defs>

  <rect width="1024" height="1024" fill="url(#sky)"/>
  <circle cx="830" cy="210" r="110" fill="#FFF4D6" opacity="0.8" filter="url(#soft)"/>
  <circle cx="150" cy="900" r="220" fill="#B9D9EE" opacity="0.6" filter="url(#soft)"/>
  <ellipse cx="512" cy="828" rx="230" ry="30" fill="#2E3A59" opacity="0.18" filter="url(#soft)"/>

  <g>
    <use href="#ear" fill="#E8954F"/>
    <use href="#earIn" fill="#F2B3A6"/>
  </g>
  <g transform="translate(1024 0) scale(-1 1)">
    <use href="#ear" fill="#E8954F"/>
    <use href="#earIn" fill="#F2B3A6"/>
  </g>

  <use href="#head" fill="url(#fur)"/>
  <g clip-path="url(#inHead)">
    <path d="M800 420 C780 640 650 760 430 810 L820 840 Z" fill="#B8642C" opacity="0.28"/>
    <g fill="#D27A37" opacity="0.6">
      <path d="M512 300 C500 340 500 372 512 396 C524 372 524 340 512 300 Z"/>
      <path d="M462 306 C456 336 460 360 474 378 C480 354 478 330 470 304 Z"/>
      <path d="M562 306 C568 336 564 360 550 378 C544 354 546 330 554 304 Z"/>
    </g>
  </g>
  <ellipse cx="392" cy="420" rx="86" ry="44" transform="rotate(-32 392 420)" fill="#FFE9D2" opacity="0.5" filter="url(#glow)"/>
  <use href="#head" fill="none" stroke="#9C5626" stroke-width="7"/>

  <ellipse cx="372" cy="612" rx="58" ry="34" fill="url(#blush)"/>
  <ellipse cx="652" cy="612" rx="58" ry="34" fill="url(#blush)"/>
  <g fill="#2B2D42">
    <ellipse cx="420" cy="540" rx="32" ry="40"/>
    <ellipse cx="604" cy="540" rx="32" ry="40"/>
  </g>
  <g fill="#FFFFFF">
    <circle cx="431" cy="524" r="12"/>
    <circle cx="410" cy="556" r="5"/>
    <circle cx="615" cy="524" r="12"/>
    <circle cx="594" cy="556" r="5"/>
  </g>
  <path d="M498 600 C504 594 520 594 526 600 C522 610 516 614 512 614 C508 614 502 610 498 600 Z" fill="#E98A8A"/>
  <path d="M512 614 C512 630 498 642 484 636 M512 614 C512 630 526 642 540 636" stroke="#9C5626" stroke-width="6" fill="none" stroke-linecap="round"/>
  <g stroke="#9C5626" stroke-width="4" stroke-linecap="round" opacity="0.7">
    <path d="M330 610 C290 604 256 606 226 614"/>
    <path d="M334 636 C296 640 266 652 240 668"/>
    <path d="M694 610 C734 604 768 606 798 614"/>
    <path d="M690 636 C728 640 758 652 784 668"/>
  </g>
</svg>
```

사진 편집·차트·이미지 변환은 SVG 가 아니라 PIL/matplotlib 을 써라. 이 문서는
**그림을 새로 그리는 경우**에만 해당한다.
