'use client';

import { useState } from 'react';
import { ApiError, api } from '../../../lib/api';
import {
  Button,
  DataTable,
  ErrorBanner,
  Field,
  Notice,
  PageHeader,
  Status,
  useResource,
} from '../../../components/ui';
import {
  DocumentLines,
  emptyDocumentLine,
  useHeldPermissions,
  useIdempotencyKeys,
  type DocumentLine,
} from '../../../components/document-lines';

interface VendorBill {
  id: string;
  legal_entity_id: string;
  vendor_id: string;
  vendor_name: string;
  vendor_invoice_number: string;
  internal_number: string | null;
  document_date: string;
  due_date: string | null;
  currency: string;
  status: string;
  match_state: string;
  total: string;
  amount_due: string;
  on_hold: boolean;
  version: string;
}

const money = (value: string | null): string =>
  value == null
    ? '—'
    : Number(value).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const OPEN_STATES = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED']);

/**
 * Vendor bills — doc 05.
 *
 * Two behaviours here are the reason this screen is not a copy of the invoices
 * one. Duplicate detection refuses a suspected duplicate outright, and the
 * documented workflow is to resubmit with an override reason (and the
 * permission) if the bill is genuinely separate — so the reason field appears
 * when the refusal happens. And a bill referencing purchase orders can be
 * matched before posting; unresolved match exceptions block the post.
 */
export default function VendorBillsPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const books = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; base_currency: string }[] }>(
            '/accounting-books',
            { query: { legal_entity_id: entityId } },
          )
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const bookId = books.data?.data[0]?.id ?? '';

  const vendors = useResource(() =>
    api<{ data: { id: string; legal_name: string; code: string | null }[] }>('/vendors'),
  );
  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/accounts', {
            query: { legal_entity_id: entityId, posting_only: 'true' },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const taxCodes = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/tax-codes', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );

  const bills = useResource(
    () =>
      entityId
        ? api<{ data: VendorBill[] }>('/vendor-bills', {
            query: { legal_entity_id: entityId, ...(statusFilter ? { status: statusFilter } : {}) },
          })
        : Promise.resolve({ data: [] }),
    [entityId, statusFilter],
  );

  const [header, setHeader] = useState({
    vendor_id: '',
    vendor_invoice_number: '',
    document_date: today(),
    posting_date: today(),
    due_date: '',
    currency: '',
    exchange_rate: '',
  });
  const set = (key: keyof typeof header) => (value: string) =>
    setHeader({ ...header, [key]: value });
  const [lines, setLines] = useState<DocumentLine[]>([emptyDocumentLine(), emptyDocumentLine()]);
  const [overrideReason, setOverrideReason] = useState('');

  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;
  const duplicateSuspected = error instanceof ApiError && error.code === 'DUPLICATE_SUSPECTED';

  const createBill = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      accounting_book_id: bookId,
      vendor_id: header.vendor_id,
      vendor_invoice_number: header.vendor_invoice_number,
      document_date: header.document_date,
      posting_date: header.posting_date,
      ...(header.due_date ? { due_date: header.due_date } : {}),
      ...(header.currency ? { currency: header.currency } : {}),
      ...(header.exchange_rate ? { exchange_rate: header.exchange_rate } : {}),
      ...(overrideReason ? { duplicate_override_reason: overrideReason } : {}),
      lines: lines
        .filter((line) => line.accountId && line.quantity && line.unitPrice)
        .map((line, index) => ({
          line_no: index + 1,
          description: line.description,
          // Strings as typed (ADR-0006 §1) — never floats.
          quantity: line.quantity,
          unit_price: line.unitPrice,
          destination_account_id: line.accountId,
          ...(line.taxCodeId ? { tax_code_id: line.taxCodeId } : {}),
          ...(line.inclusive ? { inclusive: true } : {}),
        })),
    };
    try {
      await api('/vendor-bills', {
        method: 'POST',
        idempotencyKey: keys.keyFor('create-bill', body),
        body,
      });
      keys.settle('create-bill');
      setNotice('Bill recorded as a draft. Match and post it from the list above.');
      setLines([emptyDocumentLine(), emptyDocumentLine()]);
      setHeader({ ...header, vendor_invoice_number: '', due_date: '' });
      setOverrideReason('');
      bills.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const act = async (bill: VendorBill, action: 'match' | 'post') => {
    setError(null);
    setNotice(null);
    const intent = `${action}-bill-${bill.id}`;
    try {
      await api(`/vendor-bills/${bill.id}/${action}`, {
        method: 'POST',
        // Required by the contract, generated once per intent: a retry of a
        // failed post reuses the key rather than posting twice.
        idempotencyKey: keys.keyFor(intent, {}),
        body: {},
      });
      keys.settle(intent);
      setNotice(
        action === 'match'
          ? `Matched ${bill.vendor_invoice_number} against its purchase order lines — the result is in the Match column.`
          : `Posted ${bill.vendor_invoice_number}.`,
      );
      bills.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Vendor bills"
        description="Bills from vendors. A suspected duplicate is refused with the matches named; matching against purchase orders happens before posting, and unresolved exceptions block the post (doc 05)."
      />
      <ErrorBanner error={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <div className="card">
        <Field
          label="Legal entity"
          name="entity"
          value={entityId}
          onChange={setEntityId}
          options={(entities.data?.data ?? []).map((e) => ({
            value: e.id,
            label: `${e.code} — ${e.legal_name}`,
          }))}
        />
        <Field
          label="Status"
          name="status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'DRAFT', label: 'Draft' },
            { value: 'PENDING_APPROVAL', label: 'Pending approval' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'POSTED', label: 'Posted' },
            { value: 'PARTIALLY_PAID', label: 'Partially paid' },
            { value: 'PAID', label: 'Paid' },
          ]}
        />
      </div>

      {entityId && bookId ? (
        <>
          <DataTable<VendorBill>
            caption="Vendor bills"
            rows={bills.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No bills yet. Record the first one below."
            columns={[
              {
                key: 'number',
                header: 'Internal number',
                render: (row) => row.internal_number ?? '(draft)',
              },
              {
                key: 'vendor_number',
                header: "Vendor's number",
                render: (row) => row.vendor_invoice_number,
              },
              { key: 'vendor', header: 'Vendor', render: (row) => row.vendor_name },
              { key: 'date', header: 'Document date', render: (row) => row.document_date },
              { key: 'due', header: 'Due', render: (row) => row.due_date ?? '—' },
              {
                key: 'total',
                header: 'Total',
                numeric: true,
                render: (row) => `${money(row.total)} ${row.currency}`,
              },
              {
                key: 'due_amount',
                header: 'Amount due',
                numeric: true,
                render: (row) => money(row.amount_due),
              },
              {
                key: 'match',
                header: 'Match',
                render: (row) => (
                  <>
                    {row.match_state.replace(/_/g, ' ').toLowerCase()}
                    {row.on_hold ? <span className="tag tag-danger"> on hold</span> : null}
                  </>
                ),
              },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
              {
                key: 'actions',
                header: 'Actions',
                render: (row) =>
                  OPEN_STATES.has(row.status) ? (
                    <div className="button-row">
                      {can('vendor_bill.match') ? (
                        <Button onClick={() => void act(row, 'match')}>Match</Button>
                      ) : null}
                      {can('vendor_bill.post') ? (
                        <Button variant="primary" onClick={() => void act(row, 'post')}>
                          Post
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <span className="field-hint">—</span>
                  ),
              },
            ]}
          />

          {can('vendor_bill.create') ? (
            <form onSubmit={createBill} className="card">
              <h2>New vendor bill</h2>
              <Field
                label="Vendor"
                name="vendor_id"
                value={header.vendor_id}
                onChange={set('vendor_id')}
                required
                options={(vendors.data?.data ?? []).map((v) => ({
                  value: v.id,
                  label: v.code ? `${v.code} — ${v.legal_name}` : v.legal_name,
                }))}
                error={fieldError('vendor_id')}
              />
              <Field
                label="Vendor's invoice number"
                name="vendor_invoice_number"
                value={header.vendor_invoice_number}
                onChange={set('vendor_invoice_number')}
                required
                hint="Checked for duplicates with case, spacing and zero padding normalised — INV-0042 and inv 42 are the same bill."
                error={fieldError('vendor_invoice_number')}
              />
              <Field
                label="Document date"
                name="document_date"
                type="date"
                value={header.document_date}
                onChange={set('document_date')}
                required
                error={fieldError('document_date')}
              />
              <Field
                label="Posting date"
                name="posting_date"
                type="date"
                value={header.posting_date}
                onChange={set('posting_date')}
                required
                hint="Decides the accounting period."
                error={fieldError('posting_date')}
              />
              <Field
                label="Due date"
                name="due_date"
                type="date"
                value={header.due_date}
                onChange={set('due_date')}
                hint="Leave empty to derive from the vendor's payment terms."
                error={fieldError('due_date')}
              />
              <Field
                label="Currency"
                name="currency"
                value={header.currency}
                onChange={set('currency')}
                placeholder="GBP"
                hint="Leave empty to use the vendor's default, then the book's base currency."
                error={fieldError('currency')}
              />
              <Field
                label="Exchange rate"
                name="exchange_rate"
                value={header.exchange_rate}
                onChange={set('exchange_rate')}
                hint="Only for a foreign-currency bill with no stored rate."
                error={fieldError('exchange_rate')}
              />

              {duplicateSuspected || overrideReason ? (
                <Field
                  label="Duplicate override reason"
                  name="duplicate_override_reason"
                  value={overrideReason}
                  onChange={setOverrideReason}
                  hint="The bill was refused as a suspected duplicate. If it is genuinely a separate document, say why and resubmit — this needs the vendor_bill.override_duplicate permission and is recorded in the audit trail."
                  error={fieldError('duplicate_override_reason')}
                />
              ) : null}

              <DocumentLines
                lines={lines}
                onChange={setLines}
                accounts={accounts.data?.data ?? []}
                taxCodes={taxCodes.data?.data ?? []}
                accountLabel="Destination account"
                caption="Bill lines. Enter moves down, Ctrl+Enter inserts a line, Ctrl+Delete removes one."
              />

              <Button type="submit" variant="primary" busy={busy}>
                Record bill
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </>
  );
}
