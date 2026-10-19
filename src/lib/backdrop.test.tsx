// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, render, fireEvent } from "@testing-library/react";
import { useBackdropClose } from "./backdrop";

function Modal({ onClose }: { onClose: () => void }) {
  const backdrop = useBackdropClose(onClose);
  return (
    <div data-testid="backdrop" {...backdrop}>
      <input data-testid="field" defaultValue="고를 글" />
    </div>
  );
}

describe("useBackdropClose", () => {
  afterEach(cleanup);

  it("바탕을 눌렀다 떼면 닫힌다", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Modal onClose={onClose} />);
    const backdrop = getByTestId("backdrop");
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("글칸에서 끌어 고르다 바탕에서 떼면 안 닫힌다", () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Modal onClose={onClose} />);
    fireEvent.mouseDown(getByTestId("field"));
    // 누른 곳과 뗀 곳이 다르면 click 은 둘의 공통 조상(바탕)에서 난다.
    fireEvent.click(getByTestId("backdrop"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
