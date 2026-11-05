# 그림 그리기

기본 화풍은 **낙서 스티커(이모티콘)** — 굵은 손그림 선, 단색 면, 찹쌀떡 같은 단순한 덩어리,
표정 하나로 귀여운 그림. 사람·동물·물건 무엇이든 이 방식으로 그린다. 사용자가 다른 화풍
(사실적·수채·픽셀 등)을 말하면 그걸 따르고, 아래 "SVG 규칙" 만 지킨다.

**SVG** 로 그리고, 저장한 결과를 **직접 보고 고친다.** 코드 실행으로 그림 파일이 생기면 다음
차례에 그 그림이 이미지로 너에게 보인다.

## 화풍

- **덩어리로 줄인다.** 주인공을 큰 덩어리 1~2개로(머리와 몸을 합쳐도 된다). 그 대상임을 알리는
  특징 2~3개만 남긴다(고양이 귀, 병아리 부리, 사람 앞머리…). 요청에 없는 장식(왕관·리본…)은 붙이지
  않는다. 손발은 작은 돌기 — 몸 전체가 보이면 빼먹지 마라.
- **비율.** 머리가 보이는 몸의 2/3 이상. 몸은 머리 밑의 작은 덩어리(머리 폭의 60% 이하)이거나 화면
  아래로 잘린다 — 머리만 한 상자 몸은 안 된다. 눈 하나 지름은 머리 폭의 1/5~1/4, 머리 **아래 절반**에
  양옆으로 벌려 놓는다. 그 사이 아래에 코·입을 작게.
- **선.** 먹색 하나(`#1E1B1A` 근처), 둥근 끝, 살짝 손떨림. 굵기는 둘뿐 — 덩어리 바깥 외곽선은
  `OUTLINE`, 그 안의 모든 것(눈 테두리·부리·입·팔 경계·기호)은 40% 얇은 `DETAIL`. 외곽선은 한두
  군데 끊어 손으로 그린 티를 낸다. 덩어리 안쪽 경계(팔·뺨)는 짧은 열린 선 하나로.
- **면.** 단색. 그라디언트·흐림·반사광은 쓰지 않는다. 그림자는 같은 색의 더 어두운 **단색 덩어리
  하나**를 몸 **가장자리 한쪽**(광원 반대)에 초승달처럼 `clipPath` 로 가둔다. 얼굴 가운데엔 두지 않는다.
- **얼굴이 전부.** 눈은 셋 중 하나로 표정을 정한다 — 점 / 큰 검은 원(초승달 홍채 테두리) / 실눈 선.
  코·입·부리는 **눈 하나보다 작게** — 크면 멍해 보인다. 감정은 몸짓과
  기호로: 궁금함 = 고개 기울임 + 한쪽 눈썹 + `?`, 놀람 = 큰 눈 + `!`, 기쁨 = 실눈 + 볼터치.
- **구도.** 화면을 꽉 채우거나 덩어리를 캔버스 밖까지 내보내 잘리게 한다. 고개를 기울이거나
  위·아래에서 본다. 감정 기호(`?` `!` 땀방울 하트 반짝이)나 짧은 말풍선 하나. 배경은 거의 흰 단색.
- **색.** 주인공 색 1개 + 그 그림자색 + 포인트 1~2개(분홍 귀·노란 부리…). 원색은 피한다.

## 도구

모양은 **지나갈 점 몇 개(6~12개)** 만 정하면 아래 함수가 매끈한 곡선으로 잇는다. 베지어 제어점을
직접 계산하지 마라. 둘레를 한 방향으로 따라 찍고, 볼록한 곳엔 점을 하나 더.

```python
import random

OUTLINE = 14                   # 덩어리 바깥 외곽선
DETAIL = round(OUTLINE * 0.6)  # 안쪽 디테일 선 — 외곽선보다 40% 얇게

def smooth(pts, closed=True, wobble=0.0, seed=1):
    """점들을 지나는 매끈한 곡선 path(Catmull-Rom). wobble 픽셀만큼 손떨림."""
    rnd = random.Random(seed)
    P = [(x + rnd.uniform(-wobble, wobble), y + rnd.uniform(-wobble, wobble)) for x, y in pts]
    n = len(P)
    d = f"M{P[0][0]:.1f} {P[0][1]:.1f}"
    for i in range(n if closed else n - 1):
        p0 = P[i - 1] if (closed or i > 0) else P[i]
        p1, p2 = P[i], P[(i + 1) % n]
        p3 = P[(i + 2) % n] if (closed or i + 2 < n) else p2
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}"
    return d + (" Z" if closed else "")

def shape(pts, fill, line="#1E1B1A", w=OUTLINE, gap=None, wobble=2.5, seed=1):
    """면 + 손그림 외곽선. 덩어리 안의 부품(눈·부리)은 w=DETAIL. gap=i 면 i번째와 i+1번째 점 사이
    선을 비운다. w=0 이면 선 없이 면만."""
    out = f'<path d="{smooth(pts, True, wobble, seed)}" fill="{fill}"/>'
    if not w:
        return out
    if gap is None:
        d = smooth(pts, True, wobble, seed)
    else:
        k = (gap + 1) % len(pts)
        d = smooth(pts[k:] + pts[:gap + 1], False, wobble, seed + 7)
    return out + (f'<path d="{d}" fill="none" stroke="{line}" stroke-width="{w}" '
                  'stroke-linecap="round" stroke-linejoin="round"/>')

def stroke(pts, line="#1E1B1A", w=DETAIL, wobble=2.0, seed=3):
    """열린 손그림 선 — 입·눈썹·팔 경계·기호."""
    return (f'<path d="{smooth(pts, False, wobble, seed)}" fill="none" stroke="{line}" '
            f'stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"/>')
```

쓰는 법(조각 — 모양·색·구도는 매번 새로 구상한다. 완성 예시를 따라 그리면 다 똑같아진다):

```python
body = [(260, 430), (380, 330), ...]                   # 둘레를 따라 찍은 점
svg += shape(body, "#FFE08A", gap=6)                   # 면 + 끊긴 외곽선(OUTLINE)
svg += shape(beak_pts, "#F5A623", w=DETAIL)            # 안쪽 부품은 얇은 선
svg += f'<defs><clipPath id="b"><path d="{smooth(body, True, 2.5, 1)}"/></clipPath></defs>'
svg += f'<g clip-path="url(#b)"><path d="{smooth(shadow_pts, True)}" fill="#F6C85F"/></g>'  # 그림자 덩어리
svg += stroke([(470, 780), (512, 790), (560, 778)])                                         # 입(DETAIL)
```

clipPath 의 `smooth` 는 `shape` 와 같은 `wobble`·`seed` 로 — 그래야 그림자가 선 밖으로 안 샌다.
뒤에 있는 것(귀·꼬리)을 먼저, 앞의 것(얼굴·손·기호)을 나중에 그린다.

## SVG 규칙

- `viewBox="0 0 1024 1024" width="1024" height="1024"`.
- 배경을 맨 먼저 깔아라. 투명 배경은 어둡게 보인다.
- clipPath·gradient id 가 겹치지 않게.
- `<text>` 는 말풍선의 짧은 글자만 — 글꼴이 환경마다 다르다.
- 상대 경로로 저장하면 출력 폴더(~/.nekodesk/output)에 모인다.

## 보고 고치기

저장한 그림이 보이면 아래를 확인하고, 고칠 게 있으면 **그 부분만** 고쳐 다시 저장해라.

- 무엇인지 한눈에 읽히나(특징 2~3개). 덩어리가 찌그러지거나 뾰족한 데가 없나 — 점을 옮긴다.
- 표정이 의도대로인가. 눈 위치·크기만 바꿔도 표정이 확 달라진다.
- 선이 충분히 굵고, 그림자가 선 밖으로 새지 않나.
- 화면이 휑하지 않나 — 더 크게 키우거나 잘리게.

두 번 다듬어도 더 나아지지 않으면 거기서 멈추고 결과를 보여 줘라.

## 다른 곳에 쓸 그림

Music 아트워크·배경화면처럼 다른 앱에 넣을 그림은 SVG 를 저장한 뒤 PNG 로도 굽는다:
`qlmanage -t -s 1024 -o <폴더> <파일>.svg` → `<파일>.svg.png`. 같은 이름의 예전 PNG 가
남아 있을 수 있으니, 방금 구운 파일인지 보고 써라.

사진 편집·차트·이미지 변환은 SVG 가 아니라 PIL/matplotlib 을 써라. 이 문서는
**그림을 새로 그리는 경우**에만 해당한다.
