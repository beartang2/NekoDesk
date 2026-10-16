import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import { Select as RSelect, Switch as RSwitch, ToggleGroup, Tooltip } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import "./ui.css";

/**
 * 설정 화면의 공용 컨트롤. 동작·키보드·접근성은 Radix 에 맡기고 생김새는 앱 토큰을
 * 따른다. 움직임도 App.css 의 --ease-standard / --dur-* 와 같은 값이다 — 작업 UI 라
 * 튕기지 않는다.
 */

const EASE_STANDARD = [0.22, 1, 0.36, 1] as const;

/** --dur-sheet. 접고 펴기·목록 자리 바꿈. */
export const EASE: Transition = { duration: 0.28, ease: EASE_STANDARD };

/** --dur-control. 탭 표시줄·스위치처럼 손에 붙어야 하는 것. */
export const EASE_FAST: Transition = { duration: 0.18, ease: EASE_STANDARD };

/**
 * 목록 행. 들어올 땐 살짝 내려앉고, 빠지면 나머지가 미끄러져 빈자리를 메운다.
 * `<AnimatePresence mode="popLayout">` 안에서 motion 요소에 펼쳐 쓴다.
 */
export const listItem = {
  layout: true,
  initial: { opacity: 0, y: -4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, scale: 0.96 },
  transition: EASE,
} as const;

// ── Switch ────────────────────────────────────────────────────────────────────

export function Switch({ checked, onChange, label }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
}) {
  return (
    <RSwitch.Root className="ui-switch" checked={checked} onCheckedChange={onChange} aria-label={label}>
      <RSwitch.Thumb className="ui-switch__thumb" />
    </RSwitch.Root>
  );
}

/** 이름 + 스위치 한 줄. 이름을 눌러도 켜진다. */
export function SwitchRow({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="ui-switch-row">
      <span>{label}</span>
      <Switch checked={checked} onChange={onChange} />
    </label>
  );
}

// ── Select ────────────────────────────────────────────────────────────────────

// Radix 는 빈 문자열을 "선택 지우기" 용으로 예약해 둬서 값으로 못 쓴다. 바깥은 그대로
// "" 를 쓰고 여기서만 바꿔 끼운다.
const NONE = "__none__";

export interface Option<T extends string = string> {
  value: T;
  label: string;
}

export function Select({ value, onChange, options, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
}) {
  return (
    <RSelect.Root value={value || NONE} onValueChange={(v) => onChange(v === NONE ? "" : v)}>
      <RSelect.Trigger className="ui-select">
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon className="ui-select__icon"><ChevronDown size={13} /></RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="ui-select__content" position="popper" sideOffset={4}>
          <RSelect.Viewport className="ui-select__viewport">
            {options.map((o) => (
              <RSelect.Item key={o.value || NONE} value={o.value || NONE} className="ui-select__item">
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator className="ui-select__check"><Check size={12} /></RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

// ── Segmented ─────────────────────────────────────────────────────────────────

/** 선택지가 두세 개면 펼쳐 둔다. 고른 칸 뒤의 판이 미끄러져 옮겨 간다. */
export function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (value: T) => void;
  options: Option<T>[];
}) {
  const pillId = useId();
  return (
    <ToggleGroup.Root
      type="single"
      className="ui-seg"
      value={value}
      // 이미 고른 칸을 다시 누르면 Radix 는 "" 를 준다. 선택 해제는 없다.
      onValueChange={(v) => v && onChange(v as T)}
    >
      {options.map((o) => (
        <ToggleGroup.Item key={o.value} value={o.value} className="ui-seg__item">
          {o.value === value && <motion.span layoutId={pillId} className="ui-seg__pill" transition={EASE_FAST} />}
          <span className="ui-seg__label">{o.label}</span>
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

// ── IconButton ────────────────────────────────────────────────────────────────

/**
 * 아이콘만 있는 버튼. 이름은 툴팁과 aria-label 로 같이 준다.
 * Provider 를 버튼마다 두는 건 섹션을 따로 렌더해도(테스트 등) 깨지지 않게 하려고.
 */
export function IconButton({ label, danger, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  danger?: boolean;
}) {
  return (
    <Tooltip.Provider delayDuration={400}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button type="button" aria-label={label} className={`ui-icon-btn${danger ? " ui-icon-btn--danger" : ""}`} {...rest}>
            {children}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="ui-tooltip" sideOffset={6}>{label}</Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

// ── Collapse ──────────────────────────────────────────────────────────────────

/**
 * 생겼다 사라질 때 높이째 접힌다. 갑자기 끼어들면 아래 내용이 튀어 오른다.
 * 닫히는 동안에도 마지막 내용을 그대로 보여준다(AnimatePresence 가 붙들고 있다).
 * 펴진 뒤엔 overflow 를 풀어 포커스 링이 잘리지 않게 한다.
 */
export function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className="ui-collapse"
          initial={{ height: 0, opacity: 0, overflow: "hidden" }}
          animate={{ height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } }}
          exit={{ height: 0, opacity: 0, overflow: "hidden" }}
          transition={EASE}
        >
          <div className="ui-collapse__inner">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── SavedLabel ────────────────────────────────────────────────────────────────

/** 저장 버튼 글자. 저장되면 체크와 함께 위로 밀려 바뀐다. */
export function SavedLabel({ saved, children = "저장" }: { saved: boolean; children?: ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={saved ? "saved" : "idle"}
        className="ui-saved"
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -5 }}
        transition={{ duration: 0.12, ease: EASE_STANDARD }}
      >
        {saved ? <><Check size={12} strokeWidth={2.5} />저장됨</> : children}
      </motion.span>
    </AnimatePresence>
  );
}
