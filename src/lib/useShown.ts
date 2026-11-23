import { useEffect, useState } from "react";

/** 화면 그림을 다시 그려야 할 때(엔진이 iOS 가 그림을 버린 것을 알아챘다, neko/nekoHost) 창에 보내는 이벤트 */
export const REPAINT = "neko-repaint";

/**
 * 화면이 다시 보일 때마다·다시 그려야 할 때(REPAINT) 올라가는 수(늦게 비워지는 때를 위해 조금 뒤 한 번 더). 오래 뒤에 있다 오면(폰) iOS 가 캔버스 내용을
 * 버릴 수 있어(GPU 프로세스 정리 등), 바뀔 때만 그리는 캔버스는 이 값을 다시 그릴 조건에 넣는다. 고양이 엔진은 따로 한다(revive)
 */
export function useShown(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let t = 0;
    const on = () => {
      if (document.hidden) return;
      setN((k) => k + 1);
      clearTimeout(t);
      t = window.setTimeout(() => setN((k) => k + 1), 1500);
    };
    document.addEventListener("visibilitychange", on);
    window.addEventListener(REPAINT, on);
    return () => { document.removeEventListener("visibilitychange", on); window.removeEventListener(REPAINT, on); clearTimeout(t); };
  }, []);
  return n;
}
