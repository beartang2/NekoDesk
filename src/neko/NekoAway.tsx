import { useEffect, useState } from "react";
import { nekoSnapshot } from "./NekoPortrait";
import { useNekoStore } from "./nekoStore";
import "./NekoAway.css";

/**
 * 네코가 산책 나간 동안 네코 자리에 그리는 장면: 비어 있는 방석과 팻말, 무대 밖으로 이어지는 발자국,
 * 오른쪽 끝으로 막 걸어 나가는 네코(지금 외형의 정지 그림). 엔진은 멈춰 있으니 여기선 띄우지 않는다.
 *
 * 무대는 한 장의 SVG 라 자리(사이드바 220px 안팎 · 채팅 바 아래 창 전체 폭, 높이 120~320px)가 바뀌어도
 * 비율을 지키며 글자와 함께 가운데에 놓인다. 색은 테마 변수만 써서 다크·라이트를 따로 다루지 않는다.
 * 움직임(발자국이 차례로 찍히고 네코가 들썩이며 걷는 것)은 '동작 줄이기'면 빠진다 — CSS 에서.
 */

/** 무대 밖으로 이어지는 발자국 자리(x, y, 기울기). 방석에서 오른쪽 끝으로 */
const PAWS: [number, number, number][] = [
  [110, 101, 8], [128, 95, 4], [146, 101, 10], [164, 95, 4], [182, 101, 10],
];

function Paw({ x, y, r, i }: { x: number; y: number; r: number; i: number }) {
  return (
    <g className="neko-away__paw" style={{ "--i": i } as React.CSSProperties} transform={`translate(${x} ${y}) rotate(${r + 90}) scale(1.6)`}>
      <ellipse cx="0" cy="1.2" rx="2.6" ry="2.2" />
      <circle cx="-2.6" cy="-2" r="1" />
      <circle cx="-0.9" cy="-3" r="1" />
      <circle cx="0.9" cy="-3" r="1" />
      <circle cx="2.6" cy="-2" r="1" />
    </g>
  );
}

export function NekoAway() {
  const appearance = useNekoStore((s) => s.appearance);
  const [cat, setCat] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    nekoSnapshot(appearance).then((u) => { if (alive) setCat(u); }).catch(() => {});
    return () => { alive = false; };
  }, [appearance]);

  return (
    <div className="neko-away" role="img" aria-label="네코는 지금 산책 중!">
      <p className="neko-away__caption" aria-hidden="true">네코는 지금 산책 중!</p>
      <svg className="neko-away__scene" viewBox="0 52 240 60" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
        <line className="neko-away__floor" x1="8" y1="106" x2="232" y2="106" />
        {/* 비어 있는 방석: 가운데가 꺼진 자리 */}
        <ellipse className="neko-away__cushion" cx="62" cy="100" rx="38" ry="10" />
        <ellipse className="neko-away__dent" cx="62" cy="98" rx="22" ry="5" />
        {/* 팻말 */}
        <rect className="neko-away__post" x="86" y="70" width="2.4" height="30" rx="1" />
        <rect className="neko-away__sign" x="72" y="58" width="31" height="17" rx="3" />
        <text className="neko-away__sign-text" x="87.5" y="69.6" textAnchor="middle">산책 중</text>
        {PAWS.map(([x, y, r], i) => <Paw key={i} x={x} y={y} r={r} i={i} />)}
        {/* 오른쪽 끝으로 막 나가는 네코. 무대에 반쯤 걸친다 */}
        {cat && (
          <g className="neko-away__cat">
            <image href={cat} x="200" y="58" width="50" height="50" />
          </g>
        )}
      </svg>
    </div>
  );
}
