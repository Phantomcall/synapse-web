'use client';

import React from 'react';
import { reportError } from '@/lib/telemetry';

interface TabErrorBoundaryProps {
  /** Name of the tab, used as telemetry context. */
  tabName?: string;
  /** Whether a wallet is currently connected. */
  walletConnected?: boolean;
  /** Public wallet address (logged as-is; not a secret). */
  walletAddress?: string;
  /** Contract ID involved in the failing operation. */
  contractId?: string;
  children: React.ReactNode;
}

interface TabErrorBoundaryState {
  hasError: boolean;
}

/**
 * Contains crashes inside a tab and reports them to telemetry with enough
 * context (tab name, wallet-connected state, contract ID) to debug production
 * issues. Sensitive data is scrubbed by the telemetry client before reporting.
 */
export class TabErrorBoundary extends React.Component<
  TabErrorBoundaryProps,
  TabErrorBoundaryState
> {
  state: TabErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): TabErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    reportError(error, {
      tabName: this.props.tabName,
      walletConnected: this.props.walletConnected,
      walletAddress: this.props.walletAddress,
      contractId: this.props.contractId,
      componentStack: errorInfo.componentStack,
    });
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="text-sm text-muted-foreground">
            This tab encountered an unexpected error. The issue has been
            reported.
          </p>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm"
            onClick={() => this.setState({ hasError: false })}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default TabErrorBoundary;
