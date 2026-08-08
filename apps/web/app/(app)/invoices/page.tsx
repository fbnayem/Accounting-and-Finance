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

interface Invoice {
  id: string;
  legal_entity_id: string;
  customer_id: string;
  customer_name: string;
  invoice_number: string | null;
  document_date: string;
  posting_date: string;
  due_date: string | null;
  currency: string;
  status: string;
  total: string;
  amount_paid: string | null;
  amount_due: string;
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

// A draft can be posted from any of these states; posting is what makes it a
// fact (doc 04). PENDING_APPROVAL and APPROVED still post directly here because
// the API re-checks the workflow — the button is a courtesy, not a control.
const POSTABLE = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED']);

/**
 * Sales invoices — doc 04.
 *
 * Amounts are never computed here: the client supplies quantity, price,
 * discount and tax code, and every stored amount is calculated on the server
 * ("UI may preview but server result is authoritative"). A posted invoice is
 * corrected by credit note, never edited.
 */
export default function InvoicesPage() {
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

  const customers = useResource(() =>
    api<{ data: { id: string; legal_name: string; code: string | null }[] }>('/customers'),
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

  const invoices = useResource(
    () =>
      entityId
        ? api<{ data: Invoice[] }>('/invoices', {
            query: { legal_entity_id: entityId, ...(statusFilter ? { status: statusFilter } : {}) },
          })
        : Promise.resolve({ data: [] }),
    [entityId, statusFilter],
  );

  const [header, setHeader] = useState({
    customer_id: '',
    document_date: today(),
    posting_date: today(),
    due_date: '',
    currency: '',
    exchange_rate: '',
    document_discount: '',
    terms: '',
    notes: '',
  });
  const set = (key: keyof typeof header) => (value: string) =>
    setHeader({ ...header, [key]: value });
  const [lines, setLines] = useState<DocumentLine[]>([emptyDocumentLine(), emptyDocumentLine()]);

  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  const createInvoice = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      accounting_book_id: bookId,
      customer_id: header.customer_id,
      document_date: header.document_date,
      posting_date: header.posting_date,
      ...(header.due_date ? { due_date: header.due_date } : {}),
      ...(header.currency ? { currency: header.currency } : {}),
      ...(header.exchange_rate ? { exchange_rate: header.exchange_rate } : {}),
      ...(header.document_discount ? { document_discount: header.document_discount } : {}),
      ...(header.terms ? { terms: header.terms } : {}),
      ...(header.notes ? { notes: header.notes } : {}),
      lines: lines
        .filter((line) => line.accountId && line.quantity && line.unitPrice)
        .map((line, index) => ({
          line_no: index + 1,
          description: line.description,
          // Sent as the strings the user typed (ADR-0006 §1) — a float here
          // would lose the last cent on a large amount.
          quantity: line.quantity,
          unit_price: line.unitPrice,
          revenue_account_id: line.accountId,
          ...(line.discountAmount ? { discount_amount: line.discountAmount } : {}),
          ...(line.taxCodeId ? { tax_code_id: line.taxCodeId } : {}),
          ...(line.inclusive ? { inclusive: true } : {}),
        })),
    };
    try {
      await api('/invoices', {
        method: 'POST',
        idempotencyKey: keys.keyFor('create-invoice', body),
        body,
      });
      keys.settle('create-invoice');
      setNotice('Invoice created as a draft. Post it from the list above to make it a fact.');
      setLines([emptyDocumentLine(), emptyDocumentLine()]);
      setHeader({ ...header, due_date: '', document_discount: '', terms: '', notes: '' });
      invoices.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const postInvoice = async (invoice: Invoice) => {
    setError(null);
    setNotice(null);
    const intent = `post-invoice-${invoice.id}`;
    try {
      await api(`/invoices/${invoice.id}/post`, {
        method: 'POST',
        // Required by the contract, and generated once per intent: a retry of a
        // failed post reuses the key rather than posting a second invoice.
        idempotencyKey: keys.keyFor(intent, {}),
        body: {},
      });
      keys.settle(intent);
      invoices.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Sales invoices. A draft can be edited or discarded; a posted invoice is immutable and corrected by credit note, never by editing (doc 01 rule 4)."
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
            { value: 'VOID', label: 'Void' },
          ]}
        />
      </div>

      {entityId && bookId ? (
        <>
          <DataTable<Invoice>
            caption="Invoices"
            rows={invoices.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No invoices yet. Create the first one below."
            columns={[
              {
                key: 'number',
                header: 'Number',
                render: (row) => row.invoice_number ?? '(draft)',
              },
              { key: 'customer', header: 'Customer', render: (row) => row.customer_name },
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
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
              {
                key: 'actions',
                header: 'Actions',
                render: (row) =>
                  POSTABLE.has(row.status) && can('invoice.post') ? (
                    <Button variant="primary" onClick={() => void postInvoice(row)}>
                      Post
                    </Button>
                  ) : (
                    <span className="field-hint">—</span>
                  ),
              },
            ]}
          />

          {can('invoice.create') ? (
            <form onSubmit={createInvoice} className="card">
              <h2>New invoice</h2>
              <Notice>
                Amounts are calculated on the server from quantity, price, discount and tax code —
                what you see below is a preview, never what is stored.
              </Notice>
              <Field
                label="Customer"
                name="customer_id"
                value={header.customer_id}
                onChange={set('customer_id')}
                required
                options={(customers.data?.data ?? []).map((c) => ({
                  value: c.id,
                  label: c.code ? `${c.code} — ${c.legal_name}` : c.legal_name,
                }))}
                error={fieldError('customer_id')}
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
                hint="Leave empty to derive from the customer's payment terms."
                error={fieldError('due_date')}
              />
              <Field
                label="Currency"
                name="currency"
                value={header.currency}
                onChange={set('currency')}
                placeholder="GBP"
                hint="Leave empty to use the customer's default, then the book's base currency."
                error={fieldError('currency')}
              />
              <Field
                label="Exchange rate"
                name="exchange_rate"
                value={header.exchange_rate}
                onChange={set('exchange_rate')}
                hint="Only for a foreign-currency invoice with no stored rate. A missing rate refuses rather than guesses."
                error={fieldError('exchange_rate')}
              />
              <Field
                label="Document discount"
                name="document_discount"
                value={header.document_discount}
                onChange={set('document_discount')}
                hint="A whole-document discount, applied after line discounts."
                error={fieldError('document_discount')}
              />
              <Field label="Terms" name="terms" value={header.terms} onChange={set('terms')} />
              <Field label="Notes" name="notes" value={header.notes} onChange={set('notes')} />

              <DocumentLines
                lines={lines}
                onChange={setLines}
                accounts={accounts.data?.data ?? []}
                taxCodes={taxCodes.data?.data ?? []}
                accountLabel="Revenue account"
                caption="Invoice lines. Enter moves down, Ctrl+Enter inserts a line, Ctrl+Delete removes one."
                showDiscount
              />

              <Button type="submit" variant="primary" busy={busy}>
                Create draft invoice
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </>
  );
}
