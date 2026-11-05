# 그림 그리기

기본 화풍은 **낙서 스티커(이모티콘)** — 굵은 먹선을 손으로 휙휙 그어 군데군데 끊기고, 색은 그 밑에
대충 칠해 선과 살짝 어긋난, 단순한 덩어리와 큰 눈 하나로 귀여운 그림. 사람·동물·물건 무엇이든 이
방식으로 그린다. 사용자가 다른 화풍(사실적·수채·픽셀 등)을 말하면 그걸 따르고, 아래 "SVG 규칙" 만 지킨다.

**SVG** 로 그리고, 저장한 결과를 **직접 보고 고친다.** 코드 실행으로 그림 파일이 생기면 다음
차례에 그 그림이 이미지로 너에게 보인다.

사용자가 말한 **고유한 이름**(특정 캐릭터·제품·밈)을 네가 모를 때만 그리기 전에 찾아본다 — 지어내지 말고.
알아낼 건 생김새의 사실(색·모양·눈에 띄는 특징)뿐이고, 남이 그린 그림체는 따르지 않는다. 떡·고양이·캔처럼
흔한 것은 찾지 않고 바로 그린다 — 찾으면 남의 캐릭터를 따라 그리다 이 화풍을 잃는다.

## 화풍

- **덩어리로 줄인다.** 주인공을 큰 덩어리 1~2개로(머리와 몸을 합쳐도 된다). 그 대상임을 알리는
  특징 2~3개만 남긴다(고양이 귀, 병아리 부리, 사람 앞머리…). 요청에 없는 장식(왕관·리본…)은 붙이지
  않는다. 손발은 작은 돌기 — 몸 전체가 보이면 빼먹지 마라. 소품도 특징 2~3개로 알아보게(캔: 윗테·
  따개·로고, 컵: 손잡이·김).
- **동작은 닿게.** 요청에 행동(마시기·먹기·안기·자기)이 있으면 소품이 몸에 닿아야 읽힌다 — 마시면
  캔을 기울여 입에, 먹으면 입에 물고, 들면 돌기 손이 감싼다. 표정도 그 동작에 맞춘다.
- **비율.** 머리가 보이는 몸의 2/3 이상. 몸은 머리 밑의 작은 덩어리(머리 폭의 60% 이하)이거나 화면
  아래로 잘린다 — 머리만 한 상자 몸은 안 된다.
- **선.** 먹색, 둥근 끝. 굵기는 둘뿐 — 덩어리 바깥은 `OUTLINE`, 그 안의 모든 것(눈 테두리·부리·입·
  팔 경계·기호)은 40% 얇은 `DETAIL`. 외곽선은 **이음매마다 끊는다**(귀 밑동, 머리와 몸 사이, 긴 곡선
  중간 한두 곳) — 한 바퀴 이어진 선은 스티커가 아니라 도장 같다. 안쪽 부품(주둥이·귀 안쪽·배)은 선을
  절반만 두르거나 면만 — 다 두르면 동그라미를 붙인 것 같다. 안쪽 경계(팔·뺨)는 짧은 열린 선 하나.
- **면.** 단색 2톤 — 기본색과 더 어두운 같은 계열색. 그림자는 `shape(..., dark=)` 가 빛 반대쪽
  가장자리에 **형태를 따라 휜 초승달**로 만든다. 덩어리를 가로로 반 갈라 칠하지 마라 — 몬스터볼이 된다.
  반으로 가르는 건 그 동물의 털 무늬일 때만(턱시도 고양이 얼굴 등) `clipPath` 로. 그라디언트·흐림·
  반사광은 쓰지 않는다. 면은 `shape` 가 선에서 몇 픽셀 어긋나게 깐다 — 손으로 칠한 티다. 고치지 마라.
- **얼굴이 전부.** 눈은 셋 중 하나 — 큰 검은 원(`eye()`, 초승달 홍채로 시선을 보인다) / 점 / 가는
  실눈. 큰 눈은 지름이 머리 폭의 1/4~1/3, 머리 **아래 절반**에. 코·입·부리는 **눈 하나보다 작게**, 없어도
  된다. 수염·볼터치·ω 입은 기본으로 넣지 않는다 — 넣으면 평범한 캐릭터 그림이 된다.
- **감정은 몸짓과 기호로.** 궁금함 = 고개 기울임 + 한쪽으로 쏠린 눈 + `?`, 놀람 = 올려다보는 큰 눈
  + `!`, 귀찮음 = 반쯤 감은 실눈, 기쁨 = 휜 실눈. 기호는 머리에서 떨어진 빈 곳에 크게.
- **구도.** 바짝 당겨 **화면 밖으로 잘리게**(몸 아래·옆). 고개를 기울이거나 올려다·내려다본다.
  배경은 흰색 한 가지. 짧은 말풍선이나 소품 하나까지.
- **색.** 주인공 색 1개 + 그 어두운 색 + 포인트 1~2개(분홍 귀·노란 홍채·초록 넥타이…). 원색은 피한다.

## 도구

**SVG 도형 태그(`circle` `ellipse` `rect` `polygon` `line`)는 쓰지 않는다** — 배경 `rect` 하나만 예외.
완벽한 도형은 그린 게 아니라 붙인 것처럼 보인다. 모든 모양은 아래 함수로 만든 손떨림 곡선이고,
동그라미(눈·점·발바닥)는 `ring()` 의 점으로 그린다.

모양은 **지나갈 점 몇 개(6~14개)** 만 정하면 아래 함수가 매끈한 곡선으로 잇는다. 베지어 제어점을
직접 계산하지 마라. 둘레를 한 방향으로 따라 찍고, 볼록한 곳엔 점을 하나 더. 뾰족해야 할 곳(귀 끝)은
같은 점을 두 번 — 안 그러면 둥글게 말린다. 붙어 있어야 할 덩어리(머리와 몸)는 30~60 겹치게 두고 뒤의
것(귀·몸)을 먼저 그린다 — 떨어뜨려 두면 사이가 뜬다. 캔버스 밖 좌표(-100, 1100)도 된다.

```python
import random
from math import cos, sin, pi

OUTLINE = 18                   # 덩어리 바깥 외곽선
DETAIL = round(OUTLINE * 0.6)  # 안쪽 디테일 선 — 외곽선보다 40% 얇게
INK = "#141414"

def smooth(pts, closed=True, wobble=0.0, seed=1):
    """점들을 지나는 매끈한 곡선 path(Catmull-Rom). 같은 점을 연달아 두 번 넣으면 그 자리가 꺾인다."""
    rnd, jit = random.Random(seed), {}
    for p in pts:  # 같은 자리는 같은 떨림 — 두 번 넣은 꼭짓점이 서로 어긋나지 않게
        jit.setdefault(p, (rnd.uniform(-wobble, wobble), rnd.uniform(-wobble, wobble)))
    P = [(x + jit[(x, y)][0], y + jit[(x, y)][1]) for x, y in pts]
    n = len(P)
    d = f"M{P[0][0]:.1f} {P[0][1]:.1f}"
    for i in range(n if closed else n - 1):
        p1, p2 = P[i], P[(i + 1) % n]
        if p1 == p2:  # 두 번 넣은 꼭짓점: 길이 0 구간을 곡선으로 그리면 끝에 작은 고리가 생긴다
            continue
        p0 = P[i - 1] if (closed or i > 0) else P[i]
        p3 = P[(i + 2) % n] if (closed or i + 2 < n) else p2
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}"
    return d + (" Z" if closed else "")

def _line(d, w):
    return (f'<path d="{d}" fill="none" stroke="{INK}" stroke-width="{w}" '
            'stroke-linecap="round" stroke-linejoin="round"/>')

def shape(pts, fill, w=OUTLINE, gaps=(), slip=(-5, 4), dark=None, light=(-0.12, -0.12), seed=1):
    """면 + 손그림 외곽선. gaps = 선을 비울 구간 번호들(i 는 i번째→i+1번째 점 사이).
    면은 slip 만큼 선에서 어긋나게 깐다. 덩어리 안의 부품은 w=DETAIL, w=0 이면 면만.
    dark 를 주면 그림자: 빛(light, 덩어리 크기 대비 방향) 반대쪽 가장자리에 형태를 따라 휜 초승달."""
    d = smooth(pts, True, 2.5, seed)
    if dark:
        xs, ys = [x for x, _ in pts], [y for _, y in pts]
        lx, ly = light[0] * (max(xs) - min(xs)), light[1] * (max(ys) - min(ys))
        cid = f"c{seed}_{len(pts)}_{int(xs[0])}_{int(ys[0])}"
        out = (f'<g transform="translate{slip}"><clipPath id="{cid}"><path d="{d}"/></clipPath>'
               f'<path d="{d}" fill="{dark}"/><g clip-path="url(#{cid})">'
               f'<path d="{d}" fill="{fill}" transform="translate({lx:.0f} {ly:.0f})"/></g></g>')
    else:
        out = f'<path d="{d}" fill="{fill}" transform="translate{slip}"/>'
    if not w:
        return out
    n, gaps = len(pts), sorted({g % len(pts) for g in gaps})
    if not gaps:
        return out + _line(smooth(pts, True, 2.5, seed + 7), w)
    for a, b in zip(gaps, gaps[1:] + [gaps[0] + n]):  # 끊긴 곳 사이마다 선 한 조각
        run = [pts[k % n] for k in range(a + 1, b + 1)]
        if len(run) > 1:
            out += _line(smooth(run, False, 2.5, seed + a), w)
    return out

def stroke(pts, w=DETAIL, seed=3):
    """열린 손그림 선 — 입·눈썹·팔 경계·기호."""
    return _line(smooth(pts, False, 2.0, seed), w)

def ring(cx, cy, rx, ry=None, n=10, seed=1):
    """손으로 그린 동그라미의 점들 — 살짝 찌그러져 있다. shape()·smooth() 에 넘긴다."""
    rnd, ry = random.Random(seed), ry or rx * 0.94
    return [(cx + rx * cos(2 * pi * i / n) * (1 + rnd.uniform(-0.05, 0.05)),
             cy + ry * sin(2 * pi * i / n) * (1 + rnd.uniform(-0.05, 0.05))) for i in range(n)]

def eye(cx, cy, r, look=(0, 1), iris="#E9E27A", seed=1):
    """큰 검은 눈. 홍채는 look 쪽 가장자리에 초승달로만 보인다. 두 눈의 look 을 같은 쪽으로."""
    k = (look[0] ** 2 + look[1] ** 2) ** 0.5 or 1
    px, py = cx - look[0] / k * r * 0.16, cy - look[1] / k * r * 0.16
    return (shape(ring(cx, cy, r, seed=seed), iris, w=DETAIL, slip=(0, 0), seed=seed)
            + shape(ring(px, py, r * 0.84, seed=seed + 1), INK, w=0, slip=(0, 0)))
```

쓰는 법(조각 — 모양·색·구도는 매번 새로 구상한다. 완성 예시를 따라 그리면 다 똑같아진다):

```python
svg += shape(ear_pts, "#DCDCDC", gaps=[4], seed=4)        # 뒤의 것 먼저. 귀 밑동에서 끊는다
svg += shape(head_pts, "#DCDCDC", dark="#A9A7B5", gaps=[2, 8, 11])   # 끊긴 외곽선 + 오른쪽 아래 초승달 그림자
svg += eye(340, 610, 118, look=(-0.4, 1))                  # 초승달이 아래 → 올려다보는 눈
```

빛이 오른쪽 위면 `light=(0.12, -0.12)` — 그림자는 왼쪽 아래로 간다. 털 무늬로 반을 가를 땐
clipPath 의 `smooth` 를 `shape` 와 같은 `wobble`(2.5)·`seed` 로.

## SVG 규칙

- `viewBox="0 0 1024 1024" width="1024" height="1024"`.
- 배경을 맨 먼저 깔아라(흰색). 투명 배경은 어둡게 보인다.
- clipPath·gradient id 가 겹치지 않게.
- `<text>` 는 말풍선의 짧은 글자만 — 글꼴이 환경마다 다르다.
- 상대 경로로 저장하면 출력 폴더(~/.nekodesk/output)에 모인다.

## 보고 고치기

저장한 그림이 보이면 아래를 확인하고, 고칠 게 있으면 **그 부분만** 고쳐 다시 저장해라.

- 무엇인지 한눈에 읽히나(특징 2~3개). 덩어리가 찌그러지거나 떨어진 데가 없나 — 점을 옮긴다.
- 표정이 의도대로인가. 눈 크기·위치·시선(look)만 바꿔도 표정이 확 달라진다.
- 외곽선이 이음매에서 끊겼나. 그림자가 가장자리 초승달인가(반 갈라 칠하지 않았나). 기호가 머리나 귀와 겹치지 않나.
- 화면이 휑하지 않나 — 더 크게 키우거나 잘리게.

두 번 다듬어도 더 나아지지 않으면 거기서 멈추고 결과를 보여 줘라.

## 다른 곳에 쓸 그림

Music 아트워크·배경화면처럼 다른 앱에 넣을 그림은 SVG 를 저장한 뒤 PNG 로도 굽는다:
`qlmanage -t -s 1024 -o <폴더> <파일>.svg` → `<파일>.svg.png`. 같은 이름의 예전 PNG 가
남아 있을 수 있으니, 방금 구운 파일인지 보고 써라.

사진 편집·차트·이미지 변환은 SVG 가 아니라 PIL/matplotlib 을 써라. 이 문서는
**그림을 새로 그리는 경우**에만 해당한다.
