import React from "react";

interface Props {
  children: React.ReactNode;
  /** 영역 이름 (에러 메시지에 표시). */
  label?: string;
  /** 대체 UI 커스터마이즈. 없으면 기본 복구 카드. */
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 렌더 중 throw 를 잡아 흰 화면 대신 복구 카드를 보여준다.
 * 예전엔 어떤 컴포넌트든 throw 하면 전체 트리가 unmount 돼 빈 창이 됐다.
 * 패널별로 감싸면 한 곳이 죽어도 나머지는 살아있다.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? ` ${this.props.label}` : ""}]`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="error-boundary">
        <div className="error-boundary__icon">🙀</div>
        <div className="error-boundary__title">
          {this.props.label ? `${this.props.label}에서 문제가 생겼어` : "문제가 생겼어"}
        </div>
        <div className="error-boundary__msg">{error.message}</div>
        <button className="error-boundary__retry" onClick={this.reset}>
          다시 시도
        </button>
      </div>
    );
  }
}
