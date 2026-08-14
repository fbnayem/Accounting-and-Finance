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
import { Money, SummaryList, day, useMinorUnits } from '../../../components/phase5';

interface ScheduleLine {
  id: string;
  asset_book_id: string;
  accounting_book_id: string;
  accounting_period_id: string;
  period_name: string;
  period_start: string;
  period_end: string;
  revision: number;
  scheduled_amount: string;
  posted_amount: string | null;
  status: string;
  depreciation_run_id: string | null;
  journal_entry_id: string | null;
}

interface DepreciationRun {
  id: string;
  accounting_book_id: string;
  accounting_period_id: string;
  status: string;
  total_amount: string;
  journal_entry_id: string | null;
  version: number;
  lines_posted: number;
  replayed: boolean;
}

/**
 * Depreciation — doc 09's schedule report and the period run.
 *
 * The screen is built around Phase 5's fifth exit criterion: a rerun for the
 * same asset, book and period is idempotent. The failure mode that criterion
 * guards against is invisible from a button that just says "done", so the
 * schedule distinguishes what is POSTED from what is merely SCHEDULED, every
 * posted line names the run and the journal that posted it, and a rerun that
 * posts nothing says exactly that — with the run it deferred to — rather than
 * looking like a failure and inviting someone to try again harder.
 *
 * Nothing here adds the amounts up. The run's total is the server's, computed in
 * the transaction that posted it.
 */
export default function DepreciationPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();
  const units = useMinorUnits();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');

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
  const [bookId, setBookId] = useState('');
  const book = (books.data?.data ?? []).find((b) => b.id === bookId) ?? books.data?.data[0];
  const minorUnit = units(book?.base_currency);

  const assets = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; asset_number: string; name: string; status: string }[] }>(
            '/assets',
            { query: { legal_entity_id: entityId } },
          )
        : Promise.resolve({
            data: [] as { id: string; asset_number: string; name: string; status: string }[],
          }),
    [entityId],
  );
  const [assetId, setAssetId] = useState('');

  const periods = useResource(
    () =>
      entityId
        ? api<{
            data: {
              id: string;
              name: string;
              start_date: string;
              end_date: string;
              status: string;
            }[];
          }>('/accounting-periods', { query: { legal_entity_id: entityId } })
        : Promise.resolve({
            data: [] as {
              id: string;
              name: string;
              start_date: string;
              end_date: string;
              status: string;
            }[],
          }),
    [entityId],
  );
  const [periodId, setPeriodId] = useState('');

  const schedule = useResource(
    () =>
      assetId
        ? api<{ data: ScheduleLine[] }>(`/assets/${assetId}/schedule`, {
            query: bookId ? { accounting_book_id: bookId } : {},
          })
        : Promise.resolve({ data: [] as ScheduleLine[] }),
    [assetId, bookId],
  );

  const [run, setRun] = useState<DepreciationRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lines = schedule.data?.data ?? [];
  const posted = lines.filter((l) => l.status === 'POSTED');
  const scheduled = lines.filter((l) => l.status === 'SCHEDULED');
  const revised = lines.filter((l) => l.status === 'REVISED' || l.status === 'SKIPPED');

  const runDepreciation = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = { accounting_book_id: bookId, accounting_period_id: periodId };
    try {
      const result = await api<DepreciationRun>('/assets/depreciation-runs', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('depreciation-run', body),
      });
      keys.settle('depreciation-run');
      setRun(result);
      setNotice(
        result.replayed
          ? `Nothing was posted. This period was already depreciated by run ${result.id.slice(0, 8)} ` +
              `(version ${result.version}), and that run is what you are looking at. A rerun ` +
              'posting nothing is the correct outcome, not a failure.'
          : `Posted ${result.lines_posted} schedule line(s) as run version ${result.version}.`,
      );
      schedule.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Depreciation"
        description="The schedule per asset book, and the period run. A rerun for a period already depreciated posts nothing — and says so."
      />
      <ErrorBanner error={error ?? schedule.error} />
      {notice ? <Notice tone={run?.replayed ? 'info' : 'success'}>{notice}</Notice> : null}

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
          label="Accounting book"
          name="book"
          value={bookId}
          onChange={setBookId}
          required
          options={(books.data?.data ?? []).map((b) => ({
            value: b.id,
            label: `${b.code} (${b.base_currency})`,
          }))}
          hint="Each book depreciates on its own method and life, and posts its own journals."
        />
        <Field
          label="Asset"
          name="asset"
          value={assetId}
          onChange={setAssetId}
          options={(assets.data?.data ?? []).map((a) => ({
            value: a.id,
            label: `${a.asset_number} — ${a.name}`,
          }))}
          hint="Choose an asset to read its schedule. The run below covers every asset in the book."
        />
      </div>

      {assetId ? (
        <>
          <div className="card">
            <h2>Schedule</h2>
            <SummaryList
              items={[
                {
                  term: 'Periods posted',
                  value: posted.length,
                  hint: 'Each names the run and journal that posted it.',
                },
                {
                  term: 'Periods still scheduled',
                  value: scheduled.length,
                  hint: 'These are what a future run will claim.',
                },
                { term: 'Revised or skipped', value: revised.length },
              ]}
            />
            <DataTable<ScheduleLine>
              caption="Depreciation schedule"
              rows={lines}
              rowKey={(row) => row.id}
              empty="No schedule. A schedule is written when the asset is capitalized, so an asset that has not been capitalized has none."
              columns={[
                { key: 'period', header: 'Period', render: (row) => row.period_name },
                { key: 'start', header: 'Starts', render: (row) => day(row.period_start) },
                {
                  key: 'scheduled',
                  header: 'Scheduled',
                  numeric: true,
                  render: (row) => <Money value={row.scheduled_amount} minorUnit={minorUnit} />,
                },
                {
                  key: 'posted',
                  header: 'Posted',
                  numeric: true,
                  // Never falls back to the scheduled figure: "expected 100.00"
                  // and "posted 100.00" are different facts, and a screen that
                  // conflates them cannot evidence a rerun posting nothing.
                  render: (row) =>
                    row.posted_amount === null ? (
                      <span className="field-hint">not posted</span>
                    ) : (
                      <Money value={row.posted_amount} minorUnit={minorUnit} />
                    ),
                },
                { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
                {
                  key: 'revision',
                  header: 'Revision',
                  numeric: true,
                  render: (row) => row.revision,
                },
                {
                  key: 'run',
                  header: 'Run',
                  render: (row) =>
                    row.depreciation_run_id ? row.depreciation_run_id.slice(0, 8) : '—',
                },
                {
                  key: 'journal',
                  header: 'Journal',
                  render: (row) => (row.journal_entry_id ? 'posted' : '—'),
                },
              ]}
            />
          </div>
        </>
      ) : null}

      {run ? (
        <div className="card">
          <h2>Last run</h2>
          <SummaryList
            items={[
              { term: 'Run', value: run.id.slice(0, 8) },
              { term: 'Version', value: run.version, hint: 'A period may hold several runs.' },
              { term: 'Status', value: <Status value={run.status} /> },
              {
                term: 'Total posted',
                value: <Money value={run.total_amount} minorUnit={minorUnit} />,
                hint: "The server's total for the run, not a sum of the rows above.",
              },
              { term: 'Lines posted now', value: run.lines_posted },
              {
                term: 'Replayed',
                value: run.replayed ? 'yes — nothing posted twice' : 'no',
                hint: 'Phase 5 exit criterion 5.',
              },
            ]}
          />
        </div>
      ) : null}

      {entityId && bookId ? (
        <div className="card">
          <h2>Run depreciation for a period</h2>
          <p className="page-description">
            The run claims every eligible schedule line in the book for the period and posts one
            journal. Running it again for the same period does not post a second time — it hands
            back the run that already did the work.
          </p>
          <Field
            label="Period"
            name="period"
            value={periodId}
            onChange={setPeriodId}
            required
            options={(periods.data?.data ?? []).map((p) => ({
              value: p.id,
              label: `${p.name} (${p.status.toLowerCase()})`,
            }))}
            hint="A closed period is refused by the ledger, with the period named."
          />
          {can('asset.depreciate') ? (
            <Button variant="primary" busy={busy} disabled={!periodId} onClick={runDepreciation}>
              Run depreciation
            </Button>
          ) : (
            <p className="field-hint">needs asset.depreciate</p>
          )}
        </div>
      ) : null}
    </>
  );
}
