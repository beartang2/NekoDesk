"""네코 그림 도구 — 낙서 스티커 화풍(src/agent/knowledge/drawing-pro.md).

앱이 코드 실행 때 PYTHONPATH 에 넣어 둔다. `from neko_draw import *` 로 쓴다.
상수(OUTLINE·DETAIL·FINE·INK)는 모듈 값이라, 바꾸려면 `import neko_draw as nd; nd.INK = "#2A2340"`.
"""
import random
from math import cos, sin, pi

OUTLINE = 22                   # 덩어리 바깥 외곽선
DETAIL = round(OUTLINE * 0.6)  # 안쪽 디테일 선 — 외곽선보다 40% 얇게
FINE = round(OUTLINE * 0.28)   # 빗금·머리결·주름
INK = "#141414"

def smooth(pts, closed=True, wobble=0.0, seed=1):
    """점들을 지나는 매끈한 곡선 path(Catmull-Rom). 같은 점을 연달아 두 번 넣으면 그 자리가 꺾인다.
    구간마다 살짝 휘게 한다 — 점 두 개짜리 선이나 꺾인 꼭짓점 사이도 자로 그은 직선이 되지 않게."""
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
        # 손으로 그은 선의 휨: 구간에 수직으로, 길이의 2~4%. 한쪽으로 기울어 고르지 않게
        s = rnd.choice((-1, 1))
        b1, b2 = s * rnd.uniform(0.02, 0.04), s * rnd.uniform(0.005, 0.03)
        nx, ny = p1[1] - p2[1], p2[0] - p1[0]
        c1 = (c1[0] + nx * b1, c1[1] + ny * b1)
        c2 = (c2[0] + nx * b2, c2[1] + ny * b2)
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

def eye(cx, cy, r, look=(0, 1), iris="#E9E27A", seed=1,
        lid=0.0, tilt=0.0, under=0.0, pupil=0.84, flat=1.0, shine=False):
    """큰 검은 눈. 홍채는 look 쪽 가장자리에 초승달로만 보인다. 두 눈의 look 을 같은 쪽으로.
    lid = 위 눈꺼풀이 덮는 비율(0~1), tilt = 눈꺼풀 기울기(+ 면 오른쪽이 낮다), under = 아래에서
    밀어 올린 웃는 눈꺼풀, pupil = 검은자 크기(작으면 놀란 눈), flat = 세로 납작함(작으면 가는 눈),
    shine = 흰 반짝이 두 점. 표정별 값은 eyes() 가 정해 준다."""
    k = (look[0] ** 2 + look[1] ** 2) ** 0.5 or 1
    off = r * (0.16 if pupil > 0.6 else 0.1)
    ry = r * 0.94 * flat
    if flat < 1:  # 가는 눈: 검은자를 거의 꽉 채워 위로 밀고, 홍채는 아래 가장자리에만
        px, py, prx, pry = cx - look[0] / k * r * 0.08, cy - look[1] / k * ry * 0.3, r * 0.92, ry * 0.8
    else:
        px, py, prx, pry = cx - look[0] / k * off, cy - look[1] / k * off, r * pupil, ry * pupil
    out = (shape(ring(cx, cy, r, ry, seed=seed), iris, w=DETAIL, slip=(0, 0), seed=seed)
           + shape(ring(px, py, prx, pry, seed=seed + 1), INK, w=0, slip=(0, 0)))
    if shine:
        out += (shape(ring(px - r * 0.3, py - r * 0.3, r * 0.2, seed=seed + 2), "#FFFFFF", w=0, slip=(0, 0))
                + shape(ring(px + r * 0.28, py + r * 0.14, r * 0.11, n=7, seed=seed + 3), "#FFFFFF", w=0, slip=(0, 0)))
    if not (lid or under):
        return out
    R = r * 1.4
    if lid:  # 위 눈꺼풀: 선 아래만 남긴다
        yc = cy - r + 2 * r * lid
        hw = max(r * r - (yc - cy) ** 2, (0.3 * r) ** 2) ** 0.5 * 1.06
        line = smooth([(cx - hw, yc - tilt * r * 0.5), (cx, yc + r * 0.04), (cx + hw, yc + tilt * r * 0.5)],
                      False, 1.5, seed + 4)
        keep = f"{line} L{cx + R:.1f} {cy + R:.1f} L{cx - R:.1f} {cy + R:.1f} Z"
    else:     # 웃는 눈: 아래에서 둥글게 밀어 올린 선 위만 남긴다
        top, end = cy + r - 2 * r * under, cy + r * 0.62
        mid = top + (end - top) * 0.3
        line = smooth([(cx - r * 1.02, end), (cx - r * 0.55, mid), (cx, top), (cx + r * 0.55, mid), (cx + r * 1.02, end)],
                      False, 1.5, seed + 4)
        keep = f"{line} L{cx + R:.1f} {cy - R:.1f} L{cx - R:.1f} {cy - R:.1f} Z"
    cid = f"e{seed}_{int(cx)}_{int(cy)}"
    return (f'<clipPath id="{cid}"><path d="{keep}"/></clipPath><g clip-path="url(#{cid})">{out}</g>'
            + _line(line, DETAIL))

# 표정 → eye() 값. tilt 는 왼쪽 눈 기준(오른쪽 눈은 거울로 뒤집힌다). size = 눈 크기 배율,
# size2 = 오른쪽 눈만 더 곱한다(짝짝이 — 갸웃).
MOODS = {
    "calm": {},                                  # 기본 — 동그란 큰 눈
    "shine": {"shine": True},                    # 신남·감동 — 반짝이
    "shock": {"pupil": 0.45},                    # 놀람·겁 — 검은자가 작아진다
    "curious": {"lid": 0.2, "size2": 0.85},      # 궁금함 — 윗부분이 평평한 짝짝이 눈
    "sleepy": {"lid": 0.5},                      # 졸림·귀찮음 — 반쯤 감은 눈
    "slit": {"flat": 0.36, "size": 1.25},         # 시큰둥·의심 — 가늘고 긴 눈
    "angry": {"lid": 0.32, "tilt": 0.5},         # 화남 — 안쪽이 내려간 눈꺼풀
    "sad": {"lid": 0.3, "tilt": -0.45},          # 슬픔·미안 — 바깥쪽이 내려간 눈꺼풀
    "happy": {"under": 0.5},                     # 웃음 — 아래가 둥글게 밀려 올라간 눈
}

def eyes(x1, x2, y, r, mood="calm", look=(0, 1), iris="#E9E27A", seed=1):
    """두 눈을 한 번에(x1 = 왼쪽 눈). mood: calm·shine·shock·curious·sleepy·slit·angry·sad·happy·closed."""
    if mood == "closed":  # 기쁨·만족 — 휜 실눈(∩)
        return "".join(stroke([(x - r * 0.8, y + r * 0.15), (x, y - r * 0.4), (x + r * 0.8, y + r * 0.15)],
                              seed=seed + i) for i, x in enumerate((x1, x2)))
    m = dict(MOODS[mood])
    r *= m.pop("size", 1)
    r2 = r * m.pop("size2", 1)
    tilt = m.pop("tilt", 0)
    return (eye(x1, y, r, look, iris, seed, tilt=tilt, **m)
            + eye(x2, y + (r - r2) * 0.3, r2, look, iris, seed + 10, tilt=-tilt, **m))

def save(name, *parts, bg="#FFFFFF", size=1536):
    """조각들을 SVG 한 장으로 저장한다 — 머리말·배경·닫는 태그는 여기서 붙인다(빼먹으면 그림이 깨진다).
    parts 는 shape()·stroke() 등이 돌려준 문자열(리스트도 된다). 저장한 경로를 돌려준다."""
    flat = []
    for p in parts:
        flat.extend(p if isinstance(p, (list, tuple)) else [p])
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">'
           f'<rect width="{size}" height="{size}" fill="{bg}"/>' + "".join(flat) + "</svg>")
    path = name if name.endswith(".svg") else name + ".svg"
    with open(path, "w") as f:
        f.write(svg)
    return path
