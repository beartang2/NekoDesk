# 그림 그리기

그림은 **SVG** 로 그려라. PIL/matplotlib 로 도형을 조합하지 마라 — 좌표를 눈으로
확인할 수 없어서 결과가 거의 항상 망가진다. SVG 는 곡선·그라디언트·대칭 복제를
쓸 수 있고, 저장만 하면 채팅에 그대로 렌더된다.

```python
svg = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
...
</svg>'''
open("cat.svg", "w").write(svg)
```

## 규칙

1. `viewBox="0 0 512 512"` 고정. 좌표를 매번 새로 상상하지 말고 이 격자에 맞춰라.
2. 배경 `<rect width="512" height="512">` 를 **먼저** 깔아라. 투명 배경은 어둡게 보인다.
3. 색은 **4개 이하** 팔레트로 제한. 채도 높은 원색(#FF0000, #00FF00)은 쓰지 마라.
   부드러운 색이 낫다: `#F4A259` `#E8A7A0` `#2E2E38` `#FDF6E3`.
4. 큰 덩어리부터 그리고 디테일을 위에 얹어라. 몸통 → 얼굴 → 눈 → 수염 순서.
5. 선은 `stroke-linecap="round" stroke-linejoin="round"`, 굵기는 5~8 로 통일.
6. 좌우 대칭은 좌표를 두 번 계산하지 말고 중심선(256) 기준으로 뒤집어라.
7. `<filter>` `<mask>` `<clipPath>` 는 쓰지 마라. 값이 조금만 틀려도 통째로 사라진다.
8. `<path>` 를 즉흥으로 길게 쓰지 마라. `circle` `ellipse` `rect` `polygon` 으로
   되는 건 그걸로. 곡선이 꼭 필요할 때만 `q`/`c` 를 짧게.

## 예시 — 고양이 얼굴

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="#FDF6E3"/>
  <!-- 귀 -->
  <polygon points="150,165 172,70 248,128" fill="#F4A259"/>
  <polygon points="362,165 340,70 264,128" fill="#F4A259"/>
  <polygon points="165,152 177,103 220,134" fill="#E8A7A0"/>
  <polygon points="347,152 335,103 292,134" fill="#E8A7A0"/>
  <!-- 얼굴 -->
  <ellipse cx="256" cy="262" rx="142" ry="126" fill="#F4A259"/>
  <!-- 눈 -->
  <ellipse cx="205" cy="246" rx="22" ry="27" fill="#2E2E38"/>
  <ellipse cx="307" cy="246" rx="22" ry="27" fill="#2E2E38"/>
  <circle cx="213" cy="237" r="7" fill="#FDF6E3"/>
  <circle cx="315" cy="237" r="7" fill="#FDF6E3"/>
  <!-- 코·입 -->
  <polygon points="256,292 242,278 270,278" fill="#E8A7A0"/>
  <path d="M256 294 v12 M256 306 q-18 16 -34 1 M256 306 q18 16 34 1"
        stroke="#2E2E38" stroke-width="6" fill="none" stroke-linecap="round"/>
  <!-- 수염 -->
  <g stroke="#2E2E38" stroke-width="5" stroke-linecap="round">
    <path d="M152 272 h-58 M154 294 l-56 14"/>
    <path d="M360 272 h58 M358 294 l56 14"/>
  </g>
</svg>
```

사진 편집·차트·이미지 변환은 SVG 가 아니라 PIL/matplotlib 을 써라. 이 문서는
**그림을 새로 그리는 경우**에만 해당한다.
