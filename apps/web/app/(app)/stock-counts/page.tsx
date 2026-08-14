'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
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
import { useHeldPermissions, useIdempotencyKeys } from '../../../components/document-lines';
import {
  SummaryList,
  day,
  enumOptions,
  isZeroDecimal,
  quantity,
  today,
} from '../../../components/phase5';

interface CountLine {
  id: string;
  item_id: string;
  location_id: string | null;
  expected_quantity: string;
  counted_quantity: string | null;
  variance_quantity: string | null;
  recount_required: boolean;
  counted_by?: string | null;
}

interface StockCount {
  id: string;
  legal_entity_id: string;
  warehouse_id: string;
  count_date: string;
  status: string;
  inventory_document_id?: string | null;
  lines?: CountLine[];
}

/**
 * Stock counts — doc 08's lifecycle: scope, count, recount the exceptions,
 * approve the variance, post the adjustment.
 *
 * Two rules the screen exists to make visible:
 *
 *   - Expected quantities are snapshotted when the count is created, not
 *     recomputed when it is approved. A count whose expectation moves with later
 *     postings cannot say what its variance means, so the "expected" column here
 *     is history, not a live figure.
 *   - Approving is a different permission from counting, and the server refuses
 *     approval by the person who entered the quantities (SEGREGATION_OF_DUTIES).
 *     The button is shown anyway: a refusal that names the rule teaches it, and a
 *     hidden button teaches nothing.
 *
 * Approval does not touch stock. It freezes the count and creates a DRAFT
 * variance document; posting that document — on the stock documents screen — is
 * what moves stock and the ledger.
 */
export default function StockCountsPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');

  const warehouses = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/warehouses', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] as { id: string; code: string; name: string }[] }),
    [entityId],
  );
  const [warehouseId, setWarehouseId] = useState('');

  const books = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; base_currency: string }[] }>(
            '/accounting-books',
            {
              query: { legal_entity_id: entityId },
            },
          )
        : Promise.resolve({ data: [] as { id: string; code: string; base_currency: string }[] }),
    [entityId],
  );

  const items = useResource(
    () =>
      api<{ data: { id: string; sku: string; name: string }[] }>('/items', {
        query: { legal_entity_id: entityId },
      }),
    [entityId],
  );
  const itemLabel = (id: string) =>
    (items.data?.data ?? []).find((i) => i.id === id)?.sku ?? id.slice(0, 8);

  const locations = useResource(
    () =>
      warehouseId
        ? api<{ data: { id: string; code: string; name: string }[] }>(
            `/warehouses/${warehouseId}/locations`,
          )
        : Promise.resolve({ data: [] as { id: string; code: string; name: string }[] }),
    [warehouseId],
  );
  const locationLabel = (id: string | null) =>
    id ? ((locations.data?.data ?? []).find((l) => l.id === id)?.code ?? id.slice(0, 8)) : '—';

  const [countDate, setCountDate] = useState(today());
  const [count, setCount] = useState<StockCount | null>(null);
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [nextStatus, setNextStatus] = useState('COUNTING');
  const [bookId, setBookId] = useState('');
  const [postingDate, setPostingDate] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const adopt = (result: StockCount) => {
    setCount(result);
    setEntered(
      Object.fromEntries((result.lines ?? []).map((l) => [l.id, l.counted_quantity ?? ''])),
    );
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = { warehouse_id: warehouseId, count_date: countDate };
    try {
      const created = await api<StockCount>('/inventory/counts', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('stock-count', body),
      });
      keys.settle('stock-count');
      adopt(created);
      setNotice(
        `Count ${created.id.slice(0, 8)} created with ${created.lines?.length ?? 0} line(s). ` +
          'Expected quantities are frozen as of now.',
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const save = async (status?: string) => {
    if (!count) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const lines = Object.entries(entered)
      .filter(([, value]) => value !== '')
      .map(([id, value]) => ({ id, counted_quantity: value }));
    const body = { ...(status ? { status } : {}), lines };
    try {
      const updated = await api<StockCount>(`/inventory/counts/${count.id}`, {
        method: 'PATCH',
        body,
      });
      // The PATCH answers with the lines it touched, not the whole count, so the
      // held lines are patched rather than replaced — replacing them would drop
      // every line the user has not entered yet.
      const byId = new Map((updated.lines ?? []).map((l) => [l.id, l]));
      setCount({
        ...count,
        ...updated,
        lines: (count.lines ?? []).map((line) => byId.get(line.id) ?? line),
      });
      setNotice(`${lines.length} line(s) recorded.`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!count) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      accounting_book_id: bookId || (books.data?.data[0]?.id ?? ''),
      ...(postingDate ? { posting_date: postingDate } : {}),
    };
    try {
      const approved = await api<StockCount>(`/inventory/counts/${count.id}/approve`, {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor(`approve-count-${count.id}`, body),
      });
      keys.settle(`approve-count-${count.id}`);
      setCount({ ...count, ...approved });
      setNotice(
        approved.inventory_document_id
          ? `Approved. A draft variance document (${approved.inventory_document_id.slice(0, 8)}) ` +
              'was created — post it on the stock documents screen to move stock and the ledger.'
          : 'Approved. Nothing varied, so there is no adjustment to post.',
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const lines = count?.lines ?? [];
  const uncounted = lines.filter(
    (l) => (entered[l.id] ?? '') === '' && l.counted_quantity === null,
  );
  const varied = lines.filter(
    (l) => l.variance_quantity !== null && !isZeroDecimal(l.variance_quantity),
  );

  return (
    <>
      <PageHeader
        title="Stock counts"
        description="Count a warehouse, review the variance, and hand the adjustment to someone else to accept."
      />
      <ErrorBanner error={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <div className="card">
        <Field
          label="Legal entity"
          name="entity"
          value={entityId}
          onChange={setEntityId}
          required
          options={(entities.data?.data ?? []).map((e) => ({
            value: e.id,
            label: `${e.code} — ${e.legal_name}`,
          }))}
        />
        <Field
          label="Warehouse"
          name="warehouse"
          value={warehouseId}
          onChange={setWarehouseId}
          required
          options={(warehouses.data?.data ?? []).map((w) => ({
            value: w.id,
            label: `${w.code} — ${w.name}`,
          }))}
        />
      </div>

      {count ? (
        <div className="card">
          <h2>
            Count {count.id.slice(0, 8)} — {day(count.count_date)} <Status value={count.status} />
          </h2>
          <SummaryList
            items={[
              { term: 'Lines', value: lines.length },
              {
                term: 'Not yet counted',
                value: uncounted.length,
                hint: 'Approval is refused while any line is uncounted — a variance for stock nobody looked at is not a variance.',
              },
              {
                term: 'Lines with a variance',
                value: varied.length,
                hint: 'Each becomes a movement on the draft adjustment when the count is approved.',
              },
              {
                term: 'Count id',
                value: count.id,
                hint: 'Quote this if you need to come back to it.',
              },
            ]}
          />

          <DataTable<CountLine>
            caption="Count lines"
            rows={lines}
            rowKey={(row) => row.id}
            empty="Nothing on hand in this warehouse at the count date, so there is nothing to count."
            columns={[
              { key: 'item', header: 'Item', render: (row) => itemLabel(row.item_id) },
              {
                key: 'location',
                header: 'Location',
                render: (row) => locationLabel(row.location_id),
              },
              {
                key: 'expected',
                header: 'Expected',
                numeric: true,
                render: (row) => quantity(row.expected_quantity),
              },
              {
                key: 'counted',
                header: 'Counted',
                numeric: true,
                render: (row) =>
                  count.status === 'APPROVED' || count.status === 'POSTED' ? (
                    quantity(row.counted_quantity)
                  ) : (
                    <>
                      <label className="visually-hidden" htmlFor={`counted-${row.id}`}>
                        Counted quantity for {itemLabel(row.item_id)} in{' '}
                        {locationLabel(row.location_id)}
                      </label>
                      <input
                        id={`counted-${row.id}`}
                        className="numeric"
                        inputMode="decimal"
                        value={entered[row.id] ?? ''}
                        onChange={(e) => setEntered({ ...entered, [row.id]: e.target.value })}
                      />
                    </>
                  ),
              },
              {
                key: 'variance',
                header: 'Variance',
                numeric: true,
                render: (row) => quantity(row.variance_quantity),
              },
              {
                key: 'recount',
                header: 'Recount',
                render: (row) => (row.recount_required ? 'required' : '—'),
              },
            ]}
          />

          {count.status === 'APPROVED' || count.status === 'POSTED' ? (
            <Notice tone="info">
              The quantities are now the evidence behind an accounting adjustment and can no longer
              change.
              {count.inventory_document_id
                ? ' Its variance document is a draft until someone with inventory.post posts it.'
                : ' Nothing varied, so no adjustment was created.'}
            </Notice>
          ) : (
            <>
              <div className="button-row">
                {can('inventory.count') ? (
                  <Button variant="primary" busy={busy} onClick={() => save()}>
                    Record counted quantities
                  </Button>
                ) : (
                  <span className="field-hint">needs inventory.count</span>
                )}
              </div>
              <Field
                label="Move the count to"
                name="next_status"
                value={nextStatus}
                onChange={setNextStatus}
                options={enumOptions(['COUNTING', 'RECOUNT', 'REVIEW', 'CANCELLED'])}
                hint="Approval is not here: it has its own route and its own permission."
              />
              <Button busy={busy} onClick={() => save(nextStatus)}>
                Save and move to {nextStatus.toLowerCase()}
              </Button>

              <h3>Accept the variance</h3>
              <p className="field-hint">
                Doc 08: large variances require approval — by someone else. If you entered any of
                these quantities the server will refuse this, and it will say so.
              </p>
              <Field
                label="Accounting book"
                name="approve_book"
                value={bookId || (books.data?.data[0]?.id ?? '')}
                onChange={setBookId}
                required
                options={(books.data?.data ?? []).map((b) => ({
                  value: b.id,
                  label: `${b.code} (${b.base_currency})`,
                }))}
              />
              <Field
                label="Posting date"
                name="approve_posting_date"
                type="date"
                value={postingDate}
                onChange={setPostingDate}
                hint="Leave empty to use the count date."
              />
              <Button variant="primary" busy={busy} onClick={approve}>
                Approve variance
              </Button>
            </>
          )}
        </div>
      ) : null}

      {can('inventory.count') ? (
        <form onSubmit={create} className="card">
          <h2>New count</h2>
          <Field
            label="Count date"
            name="count_date"
            type="date"
            value={countDate}
            onChange={setCountDate}
            required
            hint="Expected quantities are taken from posted movements up to this date and stored on the lines."
          />
          <Notice tone="info">
            A count exists only while this page holds it: the contract has no route to list counts
            or to read one back by id, so note the count id if you need to leave and return.
          </Notice>
          <Button type="submit" variant="primary" busy={busy} disabled={!warehouseId}>
            Create count
          </Button>
        </form>
      ) : null}
    </>
  );
}
