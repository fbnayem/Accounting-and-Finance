'use client';

import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/**
 * The accounting grid — F-407.
 *
 * The audit recorded that "accounting grid behaviour" was unspecified and deferred
 * it to the Phase 2 UI spec, with the note that it is "the first screen accountants
 * judge". This component is that spec, written as the thing itself. The behaviours
 * below are the ones every desktop ledger has had for thirty years, and their
 * absence is what makes a web accounting product feel like a form:
 *
 *   Enter        moves down the same column, adding a row at the bottom.
 *   Tab          moves across, then wraps to the next row (the browser default,
 *                which is correct here and is not overridden).
 *   Ctrl+Enter   inserts a row below the current one.
 *   Ctrl+Delete  removes the current row.
 *   Debit/credit are mutually exclusive per row: typing in one clears the other,
 *                because `jl_txn_xor` will reject the alternative anyway and
 *                finding that out at post time is a wasted round trip.
 *   The difference is always visible, and one keystroke fills it into the row the
 *                cursor is on. Hunting for a 2p imbalance by eye is the single most
 *                complained-about thing in an accounting UI.
 *
 * ADR-0010 applies throughout: the grid is a real `<table>` with a caption and
 * header cells, every cell input is labelled (visually hidden, because a visible
 * label per cell would be unreadable), the running totals are a live region so a
 * screen-reader user hears the journal come into balance, and nothing is conveyed
 * by colour alone — "out of balance by 2.00" is words.
 */

export interface GridAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly is_posting: boolean;
  readonly is_control: boolean;
  readonly status: string;
}

export interface GridRow {
  readonly key: string;
  accountId: string;
  description: string;
  debit: string;
  credit: string;
}

export function emptyRow(): GridRow {
  return {
    // Not a counter: a counter resets when the component remounts, and React reuses
    // the DOM node of a row whose key repeats — which shows the previous journal's
    // value in a new row. `randomUUID` is available in every browser we support.
    key: globalThis.crypto?.randomUUID?.() ?? `row-${Math.random().toString(36).slice(2)}`,
    accountId: '',
    description: '',
    debit: '',
    credit: '',
  };
}

const parse = (value: string): number => {
  const n = Number(value.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Presentation only. The server rounds; this formats what the server will store. */
const money = (value: number, minorUnit = 2): string =>
  value.toLocaleString(undefined, {
    minimumFractionDigits: minorUnit,
    maximumFractionDigits: minorUnit,
  });

export function JournalGrid(props: {
  rows: GridRow[];
  onChange: (rows: GridRow[]) => void;
  accounts: readonly GridAccount[];
  currency: string;
  minorUnit?: number;
  disabled?: boolean;
  footer?: ReactNode;
}) {
  const { rows, onChange, accounts } = props;
  const minorUnit = props.minorUnit ?? 2;
  const containerRef = useRef<HTMLTableSectionElement>(null);
  const [focusedRow, setFocusedRow] = useState(0);

  const postable = useMemo(
    () => accounts.filter((a) => a.is_posting && a.status === 'ACTIVE'),
    [accounts],
  );

  const totals = useMemo(() => {
    const debit = rows.reduce((a, r) => a + parse(r.debit), 0);
    const credit = rows.reduce((a, r) => a + parse(r.credit), 0);
    // Compared at the currency's minor unit rather than as floats: 0.1 + 0.2 is not
    // 0.3 in binary, and a grid that says "out of balance by 0.0000000001" is worse
    // than one that says nothing.
    const scale = 10 ** minorUnit;
    const difference = Math.round(debit * scale - credit * scale) / scale;
    return { debit, credit, difference, balanced: difference === 0 && debit > 0 };
  }, [rows, minorUnit]);

  const update = (index: number, patch: Partial<GridRow>): void => {
    const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    onChange(next);
  };

  const setAmount = (index: number, side: 'debit' | 'credit', value: string): void => {
    // Mutual exclusion, enforced as you type. `jl_txn_xor` refuses the alternative
    // at the database, so allowing both here only delays the same answer.
    update(index, side === 'debit' ? { debit: value, credit: '' } : { credit: value, debit: '' });
  };

  const insertAfter = (index: number): void => {
    const next = [...rows];
    next.splice(index + 1, 0, emptyRow());
    onChange(next);
    setFocusedRow(index + 1);
    queueMicrotask(() => focusCell(index + 1, 0));
  };

  const removeAt = (index: number): void => {
    if (rows.length <= 1) {
      onChange([emptyRow()]);
      return;
    }
    onChange(rows.filter((_, i) => i !== index));
    setFocusedRow(Math.max(0, index - 1));
  };

  const focusCell = (row: number, column: number): void => {
    const selector = `[data-cell="${row}-${column}"]`;
    containerRef.current?.querySelector<HTMLElement>(selector)?.focus();
  };

  /** Fills the outstanding difference into the row the cursor is on. */
  const balanceInto = (index: number): void => {
    if (totals.difference === 0) return;
    const magnitude = Math.abs(totals.difference).toFixed(minorUnit);
    // Debits exceed credits, so the fix is a credit — and vice versa.
    setAmount(index, totals.difference > 0 ? 'credit' : 'debit', magnitude);
  };

  const onKeyDown = (event: KeyboardEvent, index: number, column: number): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      insertAfter(index);
      return;
    }
    if (event.key === 'Delete' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      removeAt(index);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (index === rows.length - 1) insertAfter(index);
      else focusCell(index + 1, column);
      return;
    }
    if (event.key === 'ArrowDown' && index < rows.length - 1) {
      event.preventDefault();
      focusCell(index + 1, column);
    }
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault();
      focusCell(index - 1, column);
    }
  };

  return (
    <div className="grid-wrapper">
      <table className="data-table journal-grid">
        <caption>
          Journal lines. Enter moves down, Ctrl+Enter inserts a row, Ctrl+Delete removes one. A line
          carries a debit or a credit, never both.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="grid-line-no">
              #
            </th>
            <th scope="col">Account</th>
            <th scope="col">Description</th>
            <th scope="col" className="numeric">
              Debit
            </th>
            <th scope="col" className="numeric">
              Credit
            </th>
            <th scope="col">
              <span className="visually-hidden">Row actions</span>
            </th>
          </tr>
        </thead>
        <tbody ref={containerRef}>
          {rows.map((row, index) => {
            const account = accounts.find((a) => a.id === row.accountId);
            return (
              <tr key={row.key} onFocus={() => setFocusedRow(index)}>
                <td className="grid-line-no">{index + 1}</td>
                <td>
                  <label className="visually-hidden" htmlFor={`account-${row.key}`}>
                    Account for line {index + 1}
                  </label>
                  <select
                    id={`account-${row.key}`}
                    data-cell={`${index}-0`}
                    value={row.accountId}
                    disabled={props.disabled}
                    onChange={(e) => update(index, { accountId: e.target.value })}
                    onKeyDown={(e) => onKeyDown(e, index, 0)}
                  >
                    <option value="">Select an account…</option>
                    {postable.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                        {a.is_control ? ' (control)' : ''}
                      </option>
                    ))}
                  </select>
                  {account?.is_control ? (
                    // Not a colour cue: the word "control" and an explanation of what
                    // it costs. doc 02 makes this one of seven high-risk permissions.
                    <p className="field-hint">
                      Control account — posting here manually requires the journal.post_control
                      permission.
                    </p>
                  ) : null}
                </td>
                <td>
                  <label className="visually-hidden" htmlFor={`description-${row.key}`}>
                    Description for line {index + 1}
                  </label>
                  <input
                    id={`description-${row.key}`}
                    data-cell={`${index}-1`}
                    value={row.description}
                    disabled={props.disabled}
                    onChange={(e) => update(index, { description: e.target.value })}
                    onKeyDown={(e) => onKeyDown(e, index, 1)}
                  />
                </td>
                <td className="numeric">
                  <label className="visually-hidden" htmlFor={`debit-${row.key}`}>
                    Debit for line {index + 1}
                  </label>
                  <input
                    id={`debit-${row.key}`}
                    data-cell={`${index}-2`}
                    className="numeric"
                    inputMode="decimal"
                    value={row.debit}
                    disabled={props.disabled}
                    onChange={(e) => setAmount(index, 'debit', e.target.value)}
                    onKeyDown={(e) => onKeyDown(e, index, 2)}
                  />
                </td>
                <td className="numeric">
                  <label className="visually-hidden" htmlFor={`credit-${row.key}`}>
                    Credit for line {index + 1}
                  </label>
                  <input
                    id={`credit-${row.key}`}
                    data-cell={`${index}-3`}
                    className="numeric"
                    inputMode="decimal"
                    value={row.credit}
                    disabled={props.disabled}
                    onChange={(e) => setAmount(index, 'credit', e.target.value)}
                    onKeyDown={(e) => onKeyDown(e, index, 3)}
                  />
                </td>
                <td>
                  <div className="button-row">
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={props.disabled || totals.difference === 0}
                      onClick={() => balanceInto(index)}
                    >
                      Balance here
                      <span className="visually-hidden"> — line {index + 1}</span>
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={props.disabled}
                      onClick={() => removeAt(index)}
                    >
                      Remove
                      <span className="visually-hidden"> line {index + 1}</span>
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Totals</td>
            <td className="numeric">{money(totals.debit, minorUnit)}</td>
            <td className="numeric">{money(totals.credit, minorUnit)}</td>
            <td />
          </tr>
        </tfoot>
      </table>

      <div className="button-row">
        <button
          type="button"
          className="button button-secondary"
          disabled={props.disabled}
          onClick={() => insertAfter(rows.length - 1)}
        >
          Add line
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={props.disabled || totals.difference === 0}
          onClick={() => balanceInto(focusedRow)}
        >
          Balance the journal
        </button>
      </div>

      {/*
        Polite rather than assertive: the difference changes on every keystroke, and
        an assertive region would interrupt the user mid-number on each one.
      */}
      <p className="grid-balance" role="status" aria-live="polite">
        {totals.balanced ? (
          <>
            <span className="tag">Balanced</span> {money(totals.debit, minorUnit)} {props.currency}{' '}
            on both sides.
          </>
        ) : totals.difference === 0 ? (
          <>Nothing entered yet.</>
        ) : (
          <>
            <span className="tag">Out of balance</span> by{' '}
            {money(Math.abs(totals.difference), minorUnit)} {props.currency} —{' '}
            {totals.difference > 0 ? 'debits exceed credits' : 'credits exceed debits'}. A draft may
            be saved unbalanced; posting will refuse it.
          </>
        )}
      </p>
      {props.footer}
    </div>
  );
}
