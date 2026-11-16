import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Empty, LinkButton } from "../components/ui.tsx";

interface Props {
  children: ReactNode;
  /** "page": one screen broke, the app around it stays (Try again, Go home). "app": the whole app (Reload). */
  scope: "page" | "app";
  /** When this changes (a new page), a shown error is cleared and the children render again. */
  resetKey?: string;
}

/**
 * A render error never leaves a blank screen (§12.4 no dead ends): the broken part is swapped for a friendly card
 * that says what to tap next. The Shell passes the page as `resetKey`, so moving to another page clears it.
 */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.scope === "app") {
      return (
        <main className="boot" id="main">
          <h1 className="sr-only">Something went wrong</h1>
          <Empty
            icon="alert"
            title="Something went wrong"
            action={
              <Button variant="primary" icon="retry" act="retry" onClick={() => location.assign("/")}>
                Reload
              </Button>
            }
          >
            Tap Reload to start Clip Factory again.
          </Empty>
        </main>
      );
    }
    return (
      <div className="page">
        <h1 className="sr-only">Something went wrong on this page</h1>
        <Empty
          icon="alert"
          title="Something went wrong on this page"
          action={
            <>
              <Button variant="primary" icon="retry" act="retry" onClick={() => this.setState({ failed: false })}>
                Try again
              </Button>
              <LinkButton href="/" icon="home">
                Go home
              </LinkButton>
            </>
          }
        >
          Tap Try again. If it keeps happening, tap Go home.
        </Empty>
      </div>
    );
  }
}
