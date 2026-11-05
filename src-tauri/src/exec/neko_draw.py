"""네코 그림 도구 — 낙서 스티커 화풍(src/agent/knowledge/drawing-pro.md).

앱이 코드 실행 때 PYTHONPATH 에 넣어 둔다. `from neko_draw import *` 로 쓴다.
상수(OUTLINE·DETAIL·FINE·INK)는 모듈 값이라, 바꾸려면 `import neko_draw as nd; nd.INK = "#2A2340"`.
"""
import random
from math import cos, sin, pi

OUTLINE = 18                   # 덩어리 바깥 외곽선
DETAIL = round(OUTLINE * 0.6)  # 안쪽 디테일 선 — 외곽선보다 40% 얇게
FINE = round(OUTLINE * 0.28)   # 빗금·머리결·주름
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

def human_eye(cx, cy, r, iris="#5B8FD9", dark="#2F4E8C", seed=1):
    """사람 눈: 큰 홍채(위쪽 절반이 어둡다) + 굵은 윗눈꺼풀 + 흰 반사광 둘."""
    out = shape(ring(cx, cy + r * 0.08, r, r * 1.1, seed=seed), iris, w=DETAIL, slip=(0, 0),
                dark=dark, light=(0, 0.35), seed=seed)
    out += stroke([(cx - r * 1.15, cy - r * 0.55), (cx - r * 0.5, cy - r * 1.12),
                   (cx + r * 0.5, cy - r * 1.12), (cx + r * 1.15, cy - r * 0.5)], w=round(OUTLINE * 1.4), seed=seed + 2)
    out += shape(ring(cx - r * 0.35, cy - r * 0.35, r * 0.28, r * 0.22, seed=seed + 3), "#FFFFFF", w=0, slip=(0, 0))
    out += shape(ring(cx + r * 0.38, cy + r * 0.42, r * 0.12, seed=seed + 4), "#FFFFFF", w=0, slip=(0, 0))
    return out

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
