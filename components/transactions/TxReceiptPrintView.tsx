'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Transaction } from '@/lib/soroban/types';

interface TxReceiptPrintViewProps {
  transaction: Transaction;
  onClose: () => void;
}

function formatTimestamp(value?: string | number | null): string {
  if (value === undefined || value === null || value === '') return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function Field({ label, value }: { label: string; value?: string | number | null }) {
  const display =
    value === undefined || value === null || value === '' ? '—' : String(value);
  return (
    <div className="tx-receipt__field">
      <dt className="tx-receipt__label">{label}</dt>
      <dd className="tx-receipt__value">{display}</dd>
    </div>
  );
}

/**
 * Print-optimized receipt for a single transaction. Rendered through a portal
 * so it lives outside the normal app chrome; `@media print` rules in
 * globals.css hide everything else and show only this layout.
 */
export default function TxReceiptPrintView({
  transaction,
  onClose,
}: TxReceiptPrintViewProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  const liveRecordUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/transactions/${transaction.hash}`
      : `/transactions/${transaction.hash}`;

  const statusHistory = transaction.statusHistory ?? [];

  return createPortal(
    <div className="tx-receipt" role="document" aria-label="Transaction receipt">
      <header className="tx-receipt__header">
        <h1 className="tx-receipt__title">Transaction Receipt</h1>
        <p className="tx-receipt__subtitle">
          Generated {new Date().toISOString()}
        </p>
      </header>

      <section className="tx-receipt__section">
        <h2 className="tx-receipt__section-title">Transaction</h2>
        <dl className="tx-receipt__grid">
          <Field label="Hash" value={transaction.hash} />
          <Field label="Status" value={transaction.status} />
          <Field label="Ledger" value={transaction.ledger} />
          <Field label="Source Account" value={transaction.sourceAccount} />
          <Field label="Destination" value={transaction.destination} />
          <Field label="Amount" value={transaction.amount} />
          <Field label="Asset" value={transaction.asset} />
          <Field label="Fee" value={transaction.fee} />
          <Field label="Created At" value={formatTimestamp(transaction.createdAt)} />
          <Field label="Updated At" value={formatTimestamp(transaction.updatedAt)} />
          <Field label="Callback URL" value={transaction.callbackUrl} />
          <Field label="Memo" value={transaction.memo} />
        </dl>
      </section>

      <section className="tx-receipt__section">
        <h2 className="tx-receipt__section-title">Status History</h2>
        {statusHistory.length === 0 ? (
          <p className="tx-receipt__empty">No status history recorded.</p>
        ) : (
          <table className="tx-receipt__table">
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Timestamp</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {statusHistory.map((entry, index) => (
                <tr key={`${entry.status}-${index}`}>
                  <td>{entry.status}</td>
                  <td>{formatTimestamp(entry.timestamp)}</td>
                  <td>{entry.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className="tx-receipt__footer">
        <p className="tx-receipt__link">
          Live record: <span className="tx-receipt__url">{liveRecordUrl}</span>
        </p>
      </footer>

      <div className="tx-receipt__actions no-print">
        <button type="button" onClick={() => window.print()}>
          Print / Save as PDF
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
