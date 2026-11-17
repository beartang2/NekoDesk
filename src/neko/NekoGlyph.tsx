import { useId } from "react";
import type { NekoAppearance, NekoPattern, NekoPose } from "./engine/neko-engine";

/**
 * 꾸미기 칩에 붙는 작은 그림. 글자만 보고 고르지 않게, 고르면 어떤 모양이 되는지 보여 준다.
 *
 * - CatGlyph: 옆모습 실루엣(체형·다리·귀·꼬리를 반영). currentColor 로 칠해 칩 색을 따른다
 * - FurGlyph: 털 길이는 고양이 모양 대신 털 가닥 길이로(실루엣 윤곽으론 작은 크기에서 구분이 안 된다)
 * - PoseGlyph: 서기·앉기·식빵·누워 자기 실루엣
 * - PatternGlyph: 털 색 동그라미 위에 무늬(흰 반점·삼색·줄무늬·포인트)
 * - EyeGlyph: 아몬드 눈 + 홍채 색
 */

type Shape = Pick<NekoAppearance, "build" | "legs" | "ear" | "tail">;

const LEG = { short: 3, normal: 5, long: 7.5 } as const;
const BODY = { slim: [8.5, 3.6], normal: [9.5, 4.4], chubby: [10.6, 5.6] } as const;
const FLOOR = 28;

function Ears({ hx, hy, ear }: { hx: number; hy: number; ear: Shape["ear"] }) {
  if (ear === "round") {
    return (
      <>
        <circle cx={hx - 2.5} cy={hy - 4} r={2.1} />
        <circle cx={hx + 2.4} cy={hy - 4} r={2.1} />
      </>
    );
  }
  if (ear === "fold") {
    // 앞으로 접혀 머리에 붙은 귀: 낮고 끝이 앞쪽 아래로 꺾인다
    return (
      <path
        d={`M${hx - 3.8} ${hy - 2.4} Q${hx - 2.6} ${hy - 5.6} ${hx - 0.2} ${hy - 4.6} L${hx - 1.2} ${hy - 3.2} Z
            M${hx + 0.6} ${hy - 4.1} Q${hx + 2.8} ${hy - 5.8} ${hx + 4.2} ${hy - 3.1} L${hx + 2.6} ${hy - 2.9} Z`}
        strokeLinejoin="round"
        strokeWidth={0.9}
        stroke="currentColor"
      />
    );
  }
  return (
    <path
      d={`M${hx - 4} ${hy - 2} L${hx - 2.9} ${hy - 8} L${hx - 0.4} ${hy - 3.8} Z M${hx + 0.4} ${hy - 3.8} L${hx + 3} ${hy - 8} L${hx + 4.2} ${hy - 1.8} Z`}
      strokeLinejoin="round"
      strokeWidth={0.9}
      stroke="currentColor"
    />
  );
}

/** 서 있는 옆모습. 오른쪽을 본다 */
export function CatGlyph({ shape, className }: { shape: Shape; className?: string }) {
  const leg = LEG[shape.legs];
  const [rx, ry] = BODY[shape.build];
  const cx = 16, cy = FLOOR - leg - ry + 1;
  const hx = cx + rx - 2, hy = cy - ry - 1.2, hr = 4.6;
  const legXs = [cx - rx + 2.6, cx - rx + 5.2, cx + rx - 5.4, cx + rx - 2.8];
  const bx = cx - rx + 1.6, by = cy - 1.2;
  return (
    <svg className={className} viewBox="0 0 36 30" fill="currentColor" aria-hidden="true">
      {/* 꼬리 */}
      {shape.tail === "bob" ? (
        <circle cx={bx - 1.4} cy={by - 1.2} r={2.3} />
      ) : (
        <path
          d={`M${bx} ${by} C${bx - 4} ${by - 1} ${bx - 6} ${by - 6} ${bx - 4.6} ${by - 10.5}`}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={shape.tail === "fluffy" ? 4.2 : 2}
        />
      )}
      {/* 다리 */}
      <g stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
        {legXs.map((x) => <line key={x} x1={x} y1={cy} x2={x} y2={FLOOR - 1.2} />)}
      </g>
      {/* 몸통·목·머리 */}
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} />
      <path d={`M${cx + rx - 6} ${cy - ry + 0.5} L${hx - 1} ${hy + 2} L${hx + 1.5} ${hy + 3} L${cx + rx} ${cy} Z`} />
      <circle cx={hx} cy={hy} r={hr} />
      <Ears hx={hx} hy={hy} ear={shape.ear} />
    </svg>
  );
}

/**
 * 털 길이: 위쪽 피부 띠에서 털 가닥이 늘어진다. 단모는 짧고 곧게, 중모는 중간 길이로 살짝 휘게,
 * 장모는 길게 물결치며 흘러내린다
 */
const FUR_LEN = { short: 4.5, medium: 11, long: 19 } as const;
export function FurGlyph({ fur, className }: { fur: NekoAppearance["fur"]; className?: string }) {
  const len = FUR_LEN[fur], y0 = 6.5;
  const strands = [7, 12.5, 18, 23.5, 29].map((x) => {
    if (fur === "short") return `M${x} ${y0} L${x - 0.6} ${y0 + len}`;
    if (fur === "medium") return `M${x} ${y0} Q${x - 0.4} ${y0 + len * 0.6} ${x - 2.4} ${y0 + len}`;
    const y1 = y0 + len / 3, y2 = y0 + (len * 2) / 3; // 장모: S자로 두 번 굽이친다
    return `M${x} ${y0} C${x - 2.6} ${y1 - 1} ${x + 1.4} ${y1 + 1} ${x - 0.8} ${y2} S${x - 3.2} ${y0 + len - 1} ${x - 2.4} ${y0 + len}`;
  });
  return (
    <svg className={className} viewBox="0 0 36 30" aria-hidden="true">
      <rect x={3} y={2.5} width={30} height={5} rx={2.5} fill="currentColor" />
      <path d={strands.join(" ")} fill="none" stroke="currentColor" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 미리보기 자세 칩 그림 */
export function PoseGlyph({ pose, ear, className }: { pose: NekoPose; ear: Shape["ear"]; className?: string }) {
  if (pose === "stand") return <CatGlyph className={className} shape={{ build: "normal", legs: "normal", ear, tail: "long" }} />;
  return (
    <svg className={className} viewBox="0 0 36 30" fill="currentColor" aria-hidden="true">
      {pose === "sit" && (
        <>
          <path d="M10 27.4 C4 27.6 3 25 5.6 23.6" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
          <ellipse cx={15} cy={20.5} rx={6.4} ry={7.2} transform="rotate(-14 15 20.5)" />
          <line x1={19.4} y1={17} x2={19.6} y2={26.8} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" />
          <circle cx={19.5} cy={10.2} r={4.6} />
          <Ears hx={19.5} hy={10.2} ear={ear} />
        </>
      )}
      {pose === "loaf" && (
        <>
          <rect x={5} y={17.5} width={20} height={10.5} rx={5.2} />
          <circle cx={24.5} cy={16.4} r={4.6} />
          <Ears hx={24.5} hy={16.4} ear={ear} />
        </>
      )}
      {pose === "lie" && (
        <>
          <path d="M5.2 26.6 C2.4 26.6 1.6 24.4 3.4 23.4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
          <ellipse cx={15} cy={24.2} rx={10.5} ry={3.9} />
          <circle cx={27} cy={23.4} r={4.2} />
          <Ears hx={27.4} hy={23.6} ear={ear} />
        </>
      )}
    </svg>
  );
}

/** 털 색 동그라미 위 무늬 */
export function PatternGlyph({ pattern, base, className }: { pattern: NekoPattern; base: string; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      <defs>
        <clipPath id={`c${id}`}><circle cx={10} cy={10} r={9} /></clipPath>
        <radialGradient id={`g${id}`} cx="50%" cy="50%" r="55%">
          <stop offset="45%" stopColor="#3a2a22" stopOpacity={0} />
          <stop offset="100%" stopColor="#3a2a22" stopOpacity={0.75} />
        </radialGradient>
      </defs>
      <g clipPath={`url(#c${id})`}>
        <rect width={20} height={20} fill={pattern === "point" ? "#f4ece0" : base} />
        {pattern === "white" && <path d="M0 11.5 Q5 9 10 12.5 Q15 9 20 11.5 V20 H0 Z M8.6 0 H11.4 L10.6 9 H9.4 Z" fill="#fbf8f2" />}
        {pattern === "calico" && (
          <>
            <rect width={20} height={20} fill="#fbf8f2" />
            <path d="M-1 3 Q5 -1 9 4 Q8 9 2 9 Q-1 7 -1 3 Z" fill="#e2984a" />
            <path d="M11 9 Q17 7 21 11 V18 Q15 19 12 15 Q10 12 11 9 Z" fill="#2a2426" />
          </>
        )}
        {pattern === "tabby" && (
          <g fill="none" stroke="#000" strokeOpacity={0.32} strokeWidth={2} strokeLinecap="round">
            <path d="M4 2 Q6 6 4 10" /><path d="M10 1 Q12 6 10 11" /><path d="M16 2 Q18 6 16 10" />
            <path d="M3 14 Q10 12 17 14" />
          </g>
        )}
        {pattern === "point" && <rect width={20} height={20} fill={`url(#g${id})`} />}
      </g>
      <circle cx={10} cy={10} r={9} fill="none" stroke="#000" strokeOpacity={0.2} />
    </svg>
  );
}

/** 아몬드 모양 눈 + 홍채 색 */
export function EyeGlyph({ color, className }: { color: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 16" aria-hidden="true">
      <path d="M2 8 Q12 -1.5 22 8 Q12 17.5 2 8 Z" fill={color} stroke="currentColor" strokeWidth={1.2} strokeLinejoin="round" />
      <ellipse cx={12} cy={8} rx={2} ry={4.6} fill="#151216" />
      <circle cx={13.6} cy={5.6} r={1.1} fill="#fff" />
    </svg>
  );
}
