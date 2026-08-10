import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import "./CommandPalette.css";

/** ⌘K 팔레트가 실행하는 단일 명령. run 은 팔레트가 닫힌 뒤 호출된다. */
export interface Command {
  id: string;
  label: string;
  icon?: string;
  hint?: string; // 우측 보조 텍스트(단축키·날짜 등)
  keywords?: string; // 라벨 외 추가 검색어
  run: () => void;
}

/**
 * query 가 text 의 부분열이면 점수를 반환(작을수록 우선), 아니면 null.
 * 연속 부분문자열이 부분열보다 우선. 한국어는 부분문자열 매칭이 자연스럽다.
 */
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx !== -1) return idx; // 연속 일치 = 최상
  let from = 0;
  let gaps = 0;
  let prev = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, from);
    if (found === -1) return null;
    gaps += found - prev;
    prev = found;
    from = found + 1;
  }
  return 1000 + gaps; // 부분열은 부분문자열보다 뒤로
}

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    return commands
      .map((c) => ({ c, s: fuzzyScore(query, `${c.label} ${c.keywords ?? ""}`) }))
      .filter((x): x is { c: Command; s: number } => x.s !== null)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.c);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setSel(0), [query]);

  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = useCallback(
    (c: Command | undefined) => {
      if (!c) return;
      onClose();
      c.run();
    },
    [onClose],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(filtered[sel]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  if (!open) return null;

  return (
    <div className="cmdk__overlay" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="cmdk__input"
          placeholder="명령 검색…  (새 대화 · 설정 · 테마 · 세션 이동)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="cmdk__list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cmdk__empty">결과 없음</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={`cmdk__item${i === sel ? " cmdk__item--sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(c)}
              >
                {c.icon && <span className="cmdk__icon">{c.icon}</span>}
                <span className="cmdk__label">{c.label}</span>
                {c.hint && <span className="cmdk__hint">{c.hint}</span>}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
