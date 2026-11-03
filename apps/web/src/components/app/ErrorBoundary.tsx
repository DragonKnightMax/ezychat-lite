import { Component, type ErrorInfo, type ReactNode } from 'react';
import { MessageSquarePlus, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { reportClientError } from '@/lib/error-reporter';
import { Button } from '@/components/ui/button';
import { Banner } from './index';
import { openFeedback } from './FeedbackDialog';

interface Props {
  children: ReactNode;
  /** Changing this (e.g. the route path) clears the error so navigating away recovers. */
  resetKey?: string;
  /** Rendered instead of the error panel (null hides the crashed part, e.g. a nav badge). */
  fallback?: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Catches render crashes: shows an error panel instead of a blank screen and reports the error (with the
 * React component stack) to the server log via /api/client-errors.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError({
      kind: 'react',
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return <ErrorFallback error={error} />;
  }
}

function ErrorFallback({ error }: { error: Error }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="error-boundary">
      <Banner tone="danger" title={t('errorBoundary.title')}>
        <span className="break-words font-mono text-xs">{error.message}</span>
        <span className="mt-1 block">{t('errorBoundary.body')}</span>
      </Banner>
      <div>
        <Button variant="outline" size="touch" onClick={() => window.location.reload()}>
          <RotateCw aria-hidden="true" />
          {t('errorBoundary.reload')}
        </Button>{' '}
        {/* Send feedback: report the crash with its message filled in. */}
        <Button
          variant="ghost"
          size="touch"
          onClick={() =>
            openFeedback({
              type: 'problem',
              details: `\n\n${t('errorBoundary.reportPrefix')} ${error.message}`,
            })
          }
        >
          <MessageSquarePlus aria-hidden="true" />
          {t('errorBoundary.report')}
        </Button>
      </div>
    </div>
  );
}
