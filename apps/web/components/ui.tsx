'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';

/**
 * The shared pieces every Phase 1 screen is built from.
 *
 * ADR-0010 is the reason most of these exist rather than raw elements:
 *
 *   - Every input is labelled, and an invalid one is tied to its message by
 *     `aria-describedby` and marked `aria-invalid` (WCAG 3.3.1, 3.3.3).
 *   - Errors are announced in a live region, because a screen-reader user who
 *     submits a form and hears nothing has no way to know it failed (4.1.3).
 *   - Nothing conveys state by colour alone (1.4.1) — every status carries a word.
 *   - Targets are 24×24 CSS pixels minimum (2.5.8), which is why the buttons have
 *     a minimum height rather than only padding.
 */

export function Field(props: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  hint?: string;
  error?: string | undefined;
  placeholder?: string;
  options?: { value: string; label: string }[];
  autoComplete?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [props.hint ? hintId : null, props.error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="field">
      <label htmlFor={id}>
        {props.label}
        {props.required ? (
          <span className="field-required">
            {' '}
            {/* A word, not only an asterisk: "*" alone is not a text alternative. */}
            <span aria-hidden="true">*</span>
            <span className="visually-hidden">required</span>
          </span>
        ) : null}
      </label>
      {props.options ? (
        <select
          id={id}
          name={props.name}
          value={props.value}
          required={props.required}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => props.onChange(event.target.value)}
        >
          <option value="">Select…</option>
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          name={props.name}
          type={props.type ?? 'text'}
          value={props.value}
          required={props.required}
          placeholder={props.placeholder}
          autoComplete={props.autoComplete}
          aria-invalid={props.error ? true : undefined}
          aria-describedby={describedBy || undefined}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {props.hint ? (
        <p className="field-hint" id={hintId}>
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p className="field-error" id={errorId}>
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type={props.type ?? 'button'}
      className={`button button-${props.variant ?? 'secondary'}`}
      onClick={props.onClick}
      disabled={props.disabled || props.busy}
      // Announced rather than only shown as a spinner.
      aria-busy={props.busy || undefined}
    >
      {props.busy ? 'Working…' : props.children}
    </button>
  );
}

/**
 * The error banner.
 *
 * It shows the correlation ID because that is the one string a user can quote that
 * lets someone find the exact request in the logs — the API puts it on every error
 * and every log line for precisely this handoff.
 */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const api = error instanceof ApiError ? error : null;
  return (
    <div className="banner banner-danger" role="alert">
      <p className="banner-title">
        {api ? api.message : String((error as Error)?.message ?? error)}
      </p>
      {api?.fieldErrors.length ? (
        <ul>
          {api.fieldErrors.map((fieldError) => (
            <li key={`${fieldError.field}-${fieldError.code}`}>
              <strong>{fieldError.field}</strong>: {fieldError.message}
            </li>
          ))}
        </ul>
      ) : null}
      {api?.correlationId ? (
        <p className="banner-meta">
          Reference <code>{api.correlationId}</code> — quote this when reporting the problem.
        </p>
      ) : null}
    </div>
  );
}

export function Notice({
  children,
  tone = 'info',
}: {
  children: ReactNode;
  tone?: 'info' | 'success' | 'warning';
}) {
  return (
    <div className={`banner banner-${tone}`} role="status">
      {children}
    </div>
  );
}

/** A status word plus a colour, never a colour alone (WCAG 1.4.1). */
export function Status({ value }: { value: string }) {
  const tone =
    value === 'OPEN' || value === 'ACTIVE'
      ? 'ok'
      : value === 'HARD_CLOSED' || value === 'INACTIVE' || value === 'ARCHIVED'
        ? 'closed'
        : 'pending';
  return <span className={`status status-${tone}`}>{value.replace(/_/g, ' ').toLowerCase()}</span>;
}

export function DataTable<T>(props: {
  caption: string;
  columns: { key: string; header: string; render: (row: T) => ReactNode; numeric?: boolean }[];
  rows: T[];
  rowKey: (row: T) => string;
  empty?: string;
}) {
  if (props.rows.length === 0) {
    return <p className="empty">{props.empty ?? 'Nothing here yet.'}</p>;
  }
  return (
    <div className="table-scroll">
      <table>
        {/* Not decorative: a caption is how a screen-reader user knows which of
            several tables on a page they have landed in. */}
        <caption>{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th key={column.key} scope="col" className={column.numeric ? 'numeric' : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr key={props.rowKey(row)}>
              {props.columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'numeric' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

/** Loads once on mount and re-loads when `deps` change. */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadRef
      .current()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // Spread, not `[deps, nonce]` — F-721. Every call site passes an array
    // literal, so a dependency list containing the array compares a fresh
    // identity on every render: the effect re-ran after each commit, each
    // completed fetch set state, and that commit started the next fetch. A
    // continuous refetch loop paced by network latency, on every screen, with no
    // symptom other than traffic. The loader is held in a ref so the spread is
    // the honest dependency list rather than a lie about the closure.
  }, [...deps, nonce]);

  return { data, error, loading, reload: () => setNonce((n) => n + 1) };
}
