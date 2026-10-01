import "./Counter.css";

/**
 * 숫자가 바뀌면 자릿수가 굴러서 바뀌는 카운터 (reactbits 의 Counter).
 *
 * 원본은 motion 의 스프링으로 각 자리를 굴린다. 여기서는 0~9 를 세로로 쌓아 두고
 * CSS 로 밀어 올린다 — 지금 숫자만큼 올리면 그 칸이 창에 보인다.
 *
 * 쉼표·슬래시 같은 글자는 굴리지 않는다. 자리값이 아니라 구분자라 움직이면 글자가
 * 춤추는 것처럼 보인다.
 */

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

export function Counter({ value, className }: { value: number; className?: string }) {
  const text = value.toLocaleString();
  const chars = [...text];

  return (
    <span className={`counter ${className ?? ""}`} aria-label={text}>
      {chars.map((ch, i) => {
        if (!/\d/.test(ch)) {
          return <span key={i} className="counter__sep" aria-hidden="true">{ch}</span>;
        }
        return (
          <span key={i} className="counter__digit" aria-hidden="true">
            <span
              className="counter__column"
              /* 오른쪽 자리부터 굴러 왼쪽으로 번진다. 한꺼번에 돌면 숫자가 아니라
                 무늬로 보인다. */
              style={{
                transform: `translateY(${-Number(ch) * 10}%)`,
                transitionDelay: `${(chars.length - 1 - i) * 35}ms`,
              }}
            >
              {DIGITS.map((d) => (
                <span key={d} className="counter__cell">{d}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
