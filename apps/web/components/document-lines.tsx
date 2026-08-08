'use client';

import { useRef, type KeyboardEvent } from 'react';
import { api, newIdempotencyKey } from '../lib/api';
import { useResource } from './ui';

/**
 * The pieces the Phase 3 document screens share: the invoice/bill line editor,
 * the idempotency-key ledger, and the caller's own permissions.
 *
 * The line editor deliberately repeats the journal grid's keyboard behaviour
 * (Enter down, Ctrl+Enter insert, Ctrl+Delete remove) — a person who learns the
 * grid on the journals screen must not have to relearn it on an invoice.
 *
 * Every amount is a string end to end (ADR-0006 §1). The inputs are text with
 * inputMode="decimal", and the value sent is the string the user typed — a
 * number input would hand us a float and silently lose the last cent.
 */

export interface DocumentLine {
  readonly key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  accountId: string;
  taxCodeId: string;
  inclusive: boolean;
}

export function emptyDocumentLine(): DocumentLine {
  return {
    // Not a counter: a counter resets on remount and React reuses the DOM node
    // of a repeated key, showing a previous document's value in a new line.
    key: globalThis.crypto?.randomUUID?.() ?? `line-${Math.random().toString(36).slice(2)}`,
    description: '',
    quantity: '',
    unitPrice: '',
    discountAmount: '',
    accountId: '',
    taxCodeId: '',
    inclusive: false,
  };
}

export interface AccountOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface TaxCodeOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/**
 * A key per user intent, not per HTTP call.
 *
 * The contract marks posting operations `x-idempotency: required`, and the rule
 * that makes the key worth sending is that a retry of the same submission
 * reuses it — a key regenerated on retry posts a second invoice. The key is
 * held against the serialized body, so retrying unchanged input reuses the key
 * while an edited resubmission (a different intent) gets a fresh one. `settle`
 * is called once the submission succeeds and the intent no longer exists.
 */
export function useIdempotencyKeys() {
  const held = useRef(new Map<string, { body: string; key: string }>());

  const keyFor = (intent: string, body: unknown): string => {
    const serialized = JSON.stringify(body);
    const existing = held.current.get(intent);
    if (existing && existing.body === serialized) return existing.key;
    const key = newIdempotencyKey(intent);
    held.current.set(intent, { body: serialized, key });
    return key;
  };

  const settle = (intent: string): void => {
    held.current.delete(intent);
  };

  return { keyFor, settle };
}

/**
 * The caller's effective permissions, the same way the shell derives them.
 *
 * Hiding a control is a courtesy and never a control — the API refuses the call
 * regardless — so this fails open: while loading, or if the lookup fails, the
 * answer is null and callers should show the control rather than hide a
 * capability the person may actually hold.
 */
export function useHeldPermissions(): Set<string> | null {
  const loaded = useResource(async () => {
    const [roles, memberships] = await Promise.all([
      api<{ data: { id: string; permissions: string[] }[] }>('/roles'),
      api<{ data: { role_id: string }[] }>('/memberships'),
    ]);
    const mine = new Set(memberships.data.map((m) => m.role_id));
    const held = new Set<string>();
    for (const role of roles.data) {
      if (mine.has(role.id)) role.permissions.forEach((p) => held.add(p));
    }
    return held;
  });
  return loaded.data;
}

const parse = (value: string): number => {
  const n = Number(value.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Presentation only. The server's calculation is authoritative (doc 04). */
const money = (value: number): string =>
  value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function DocumentLines(props: {
  lines: DocumentLine[];
  onChange: (lines: DocumentLine[]) => void;
  accounts: readonly AccountOption[];
  taxCodes: readonly TaxCodeOption[];
  /** "Revenue account" on an invoice, "Destination account" on a bill. */
  accountLabel: string;
  caption: string;
  showDiscount?: boolean;
  disabled?: boolean;
}) {
  const { lines, onChange } = props;
  const containerRef = useRef<HTMLTableSectionElement>(null);

  // Column order for keyboard navigation. The discount column only exists on
  // documents that carry line discounts (invoices), so the indices shift.
  const col = {
    description: 0,
    quantity: 1,
    unitPrice: 2,
    discount: 3,
    account: props.showDiscount ? 4 : 3,
    tax: props.showDiscount ? 5 : 4,
  };

  const update = (index: number, patch: Partial<DocumentLine>): void => {
    onChange(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const insertAfter = (index: number): void => {
    const next = [...lines];
    next.splice(index + 1, 0, emptyDocumentLine());
    onChange(next);
    queueMicrotask(() => focusCell(index + 1, col.description));
  };

  const removeAt = (index: number): void => {
    if (lines.length <= 1) {
      onChange([emptyDocumentLine()]);
      return;
    }
    onChange(lines.filter((_, i) => i !== index));
  };

  const focusCell = (row: number, column: number): void => {
    containerRef.current?.querySelector<HTMLElement>(`[data-cell="${row}-${column}"]`)?.focus();
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
      if (index === lines.length - 1) insertAfter(index);
      else focusCell(index + 1, column);
      return;
    }
    if (event.key === 'ArrowDown' && index < lines.length - 1) {
      event.preventDefault();
      focusCell(index + 1, column);
    }
    if (event.key === 'ArrowUp' && index > 0) {
      event.preventDefault();
      focusCell(index - 1, column);
    }
  };

  // As entered, before the server applies tax and rounding. Shown so a typo in
  // a quantity is visible before submission, never stored anywhere.
  const enteredTotal = lines.reduce(
    (a, line) => a + parse(line.quantity) * parse(line.unitPrice) - parse(line.discountAmount),
    0,
  );

  return (
    <div className="grid-wrapper">
      <table className="data-table journal-grid document-grid">
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="grid-line-no">
              #
            </th>
            <th scope="col">Description</th>
            <th scope="col" className="numeric">
              Quantity
            </th>
            <th scope="col" className="numeric">
              Unit price
            </th>
            {props.showDiscount ? (
              <th scope="col" className="numeric">
                Discount
              </th>
            ) : null}
            <th scope="col">{props.accountLabel}</th>
            <th scope="col">Tax code</th>
            <th scope="col">Incl. tax</th>
            <th scope="col">
              <span className="visually-hidden">Row actions</span>
            </th>
          </tr>
        </thead>
        <tbody ref={containerRef}>
          {lines.map((line, index) => (
            <tr key={line.key}>
              <td className="grid-line-no">{index + 1}</td>
              <td>
                <label className="visually-hidden" htmlFor={`description-${line.key}`}>
                  Description for line {index + 1}
                </label>
                <input
                  id={`description-${line.key}`}
                  data-cell={`${index}-${col.description}`}
                  value={line.description}
                  disabled={props.disabled}
                  onChange={(e) => update(index, { description: e.target.value })}
                  onKeyDown={(e) => onKeyDown(e, index, col.description)}
                />
              </td>
              <td className="numeric">
                <label className="visually-hidden" htmlFor={`quantity-${line.key}`}>
                  Quantity for line {index + 1}
                </label>
                <input
                  id={`quantity-${line.key}`}
                  data-cell={`${index}-${col.quantity}`}
                  className="numeric"
                  inputMode="decimal"
                  value={line.quantity}
                  disabled={props.disabled}
                  onChange={(e) => update(index, { quantity: e.target.value })}
                  onKeyDown={(e) => onKeyDown(e, index, col.quantity)}
                />
              </td>
              <td className="numeric">
                <label className="visually-hidden" htmlFor={`unit-price-${line.key}`}>
                  Unit price for line {index + 1}
                </label>
                <input
                  id={`unit-price-${line.key}`}
                  data-cell={`${index}-${col.unitPrice}`}
                  className="numeric"
                  inputMode="decimal"
                  value={line.unitPrice}
                  disabled={props.disabled}
                  onChange={(e) => update(index, { unitPrice: e.target.value })}
                  onKeyDown={(e) => onKeyDown(e, index, col.unitPrice)}
                />
              </td>
              {props.showDiscount ? (
                <td className="numeric">
                  <label className="visually-hidden" htmlFor={`discount-${line.key}`}>
                    Discount amount for line {index + 1}
                  </label>
                  <input
                    id={`discount-${line.key}`}
                    data-cell={`${index}-${col.discount}`}
                    className="numeric"
                    inputMode="decimal"
                    value={line.discountAmount}
                    disabled={props.disabled}
                    onChange={(e) => update(index, { discountAmount: e.target.value })}
                    onKeyDown={(e) => onKeyDown(e, index, col.discount)}
                  />
                </td>
              ) : null}
              <td>
                <label className="visually-hidden" htmlFor={`account-${line.key}`}>
                  {props.accountLabel} for line {index + 1}
                </label>
                <select
                  id={`account-${line.key}`}
                  data-cell={`${index}-${col.account}`}
                  value={line.accountId}
                  disabled={props.disabled}
                  onChange={(e) => update(index, { accountId: e.target.value })}
                  onKeyDown={(e) => onKeyDown(e, index, col.account)}
                >
                  <option value="">Select an account…</option>
                  {props.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <label className="visually-hidden" htmlFor={`tax-code-${line.key}`}>
                  Tax code for line {index + 1}
                </label>
                <select
                  id={`tax-code-${line.key}`}
                  data-cell={`${index}-${col.tax}`}
                  value={line.taxCodeId}
                  disabled={props.disabled}
                  onChange={(e) => update(index, { taxCodeId: e.target.value })}
                  onKeyDown={(e) => onKeyDown(e, index, col.tax)}
                >
                  <option value="">No tax</option>
                  {props.taxCodes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.code} — {t.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <label className="visually-hidden" htmlFor={`inclusive-${line.key}`}>
                  Price includes tax for line {index + 1}
                </label>
                <input
                  id={`inclusive-${line.key}`}
                  type="checkbox"
                  checked={line.inclusive}
                  disabled={props.disabled}
                  onChange={(e) => update(index, { inclusive: e.target.checked })}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={props.disabled}
                  onClick={() => removeAt(index)}
                >
                  Remove
                  <span className="visually-hidden"> line {index + 1}</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Total as entered</td>
            <td className="numeric">{money(enteredTotal)}</td>
            <td colSpan={props.showDiscount ? 5 : 4} className="muted">
              Before tax and rounding — the server&rsquo;s calculation is authoritative.
            </td>
          </tr>
        </tfoot>
      </table>

      <div className="button-row">
        <button
          type="button"
          className="button button-secondary"
          disabled={props.disabled}
          onClick={() => insertAfter(lines.length - 1)}
        >
          Add line
        </button>
      </div>
    </div>
  );
}
