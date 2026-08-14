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

interface BankTransaction {
  id: string;
  bank_account_id: string;
  transaction_date: string;
  value_date: string | null;
  currency: string;
  amount: string;
  description: string | null;
  counterparty_name: string | null;
  reference: string | null;
  running_balance: string | null;
  reconciliation_state: string;
  parent_transaction_id: string | null;
}

interface Candidate {
  target_type: string;
  target_id: string;
  reference: string | null;
  counterparty: string | null;
  amount: string;
  currency: string;
  date: string;
  score: number;
  exact: boolean;
  auto_matchable: boolean;
  factors: Record<string, number>;
}

interface CandidateResponse {
  bank_transaction_id: string;
  amount: string;
  direction: string;
  candidates: Candidate[];
  note: string;
}

const money = (value: string | null): string =>
  value == null
    ? '—'
    : Number(value).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

/**
 * The unsigned magnitude, as text.
 *
 * A bank line's sign is the direction of the movement; a matched amount is a
 * quantity. Stripping the character rather than negating a number keeps the
 * server's exact decimal intact all the way back to the server (ADR-0006 §1).
 */
const magnitude = (value: string): string => (value.startsWith('-') ? value.slice(1) : value);

const STATES = ['UNMATCHED', 'SUGGESTED', 'MATCHED', 'RECONCILED', 'IGNORED', 'SPLIT'];

/**
 * Imported bank lines, and the matching workspace — doc 06.
 *
 * The scoring is shown, not just the ranking. A suggestion a person is asked to
 * confirm has to be arguable: the weighted factors behind a 0.97 are the
 * difference between "the system says so" and "the amount is exact, the
 * reference matches and the date is two days out". Phase 4's fifth exit
 * criterion is that a suggestion never posts by itself, and this screen is where
 * that promise is either kept or quietly broken — so confirming is a separate,
 * permissioned click, and a candidate that cannot be auto-matched says why.
 */
export default function BankTransactionsPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');

  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; name: string; currency: string }[] }>('/bank-accounts', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );

  const [accountId, setAccountId] = useState('');
  const [state, setState] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const transactions = useResource(
    () =>
      accountId
        ? api<{ data: BankTransaction[] }>('/bank-transactions', {
            query: { bank_account_id: accountId, state, from, to },
          })
        : Promise.resolve({ data: [] }),
    [accountId, state, from, to],
  );

  const [selected, setSelected] = useState<BankTransaction | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const candidates = useResource(
    () =>
      selected
        ? api<CandidateResponse>(`/bank-transactions/${selected.id}/matches`)
        : Promise.resolve(null),
    [selected?.id],
  );

  // Statement import lives here rather than on the accounts screen: the file and
  // the rows it produces are the same act, and the reviewer of a suspected
  // duplicate needs to be looking at the ledger it landed in.
  const [importFormat, setImportFormat] = useState('CSV');
  const [importContent, setImportContent] = useState('');

  const runImport = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = { format: importFormat, content: importContent };
    try {
      const result = await api<{
        imported: number;
        duplicates: number;
        suspected_duplicates: number;
        replayed: boolean;
      }>(`/bank-accounts/${accountId}/imports`, {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('bank-import', body),
      });
      keys.settle('bank-import');
      setNotice(
        result.replayed
          ? 'This statement was already imported — nothing was added. Re-importing the same file is safe.'
          : `${result.imported} imported, ${result.duplicates} refused as already recorded, ` +
              `${result.suspected_duplicates} flagged for review.`,
      );
      setImportContent('');
      transactions.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const confirmMatch = async (candidate: Candidate) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      targets: [
        {
          target_type: candidate.target_type,
          target_id: candidate.target_id,
          // The bank line's own magnitude, not the candidate's: matching more
          // than the transaction is worth is refused (OVER_ALLOCATION), and
          // matching a document's full value against a part payment would be
          // exactly that. As text throughout — `Number(...).toFixed(2)` would
          // round the server's 8-decimal value in binary before sending it,
          // which is the conversion ADR-0006 §1 exists to prevent.
          matched_amount: magnitude(selected.amount),
        },
      ],
    };
    try {
      const result = await api<{ fully_matched: boolean }>(
        `/bank-transactions/${selected.id}/match`,
        { method: 'POST', body, idempotencyKey: keys.keyFor('bank-match', body) },
      );
      keys.settle('bank-match');
      setNotice(
        result.fully_matched
          ? 'Matched in full. Settling the document itself is a separate AR/AP action.'
          : 'Recorded as a partial match; the line stays open for the rest.',
      );
      setSelected(null);
      transactions.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Bank transactions"
        description="Imported bank lines and the matching workspace. A suggestion is never posted by the system — confirming one is a separate action."
      />
      <ErrorBanner error={error ?? transactions.error ?? candidates.error} />
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
          label="Bank account"
          name="bank_account"
          value={accountId}
          onChange={setAccountId}
          required
          options={(accounts.data?.data ?? []).map((a) => ({
            value: a.id,
            label: `${a.name} (${a.currency})`,
          }))}
        />
        <Field
          label="State"
          name="state"
          value={state}
          onChange={setState}
          options={STATES.map((s) => ({ value: s, label: s.replace(/_/g, ' ').toLowerCase() }))}
          hint="Leave empty for every state."
        />
        <Field label="From" name="from" type="date" value={from} onChange={setFrom} />
        <Field label="To" name="to" type="date" value={to} onChange={setTo} />
      </div>

      {accountId ? (
        <>
          <DataTable<BankTransaction>
            caption="Bank lines"
            rows={transactions.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No transactions match these filters."
            columns={[
              { key: 'date', header: 'Date', render: (row) => row.transaction_date.slice(0, 10) },
              {
                key: 'counterparty',
                header: 'Counterparty',
                render: (row) => row.counterparty_name ?? row.description ?? '—',
              },
              { key: 'reference', header: 'Reference', render: (row) => row.reference ?? '—' },
              {
                key: 'amount',
                header: 'Amount',
                numeric: true,
                render: (row) => money(row.amount),
              },
              {
                key: 'state',
                header: 'State',
                render: (row) => <Status value={row.reconciliation_state} />,
              },
              {
                key: 'actions',
                header: 'Match',
                render: (row) =>
                  row.reconciliation_state === 'SPLIT' ? (
                    // The parent of a split is deliberately unmatchable: the
                    // children carry the cash, and matching both would count it
                    // twice. The server refuses it; saying so here saves a click
                    // that can only fail.
                    <span className="field-hint">split — match the parts</span>
                  ) : (
                    <Button onClick={() => setSelected(row)}>Find candidates</Button>
                  ),
              },
            ]}
          />

          {selected ? (
            <div className="card">
              <h2>
                Candidates for {money(selected.amount)} on {selected.transaction_date.slice(0, 10)}
              </h2>
              <p className="page-description">
                {candidates.data?.note ??
                  'Suggestions only. Confirming a match is a separate, permissioned action.'}
              </p>
              <DataTable<Candidate>
                caption="Ranked candidates"
                rows={candidates.data?.candidates ?? []}
                rowKey={(row) => `${row.target_type}-${row.target_id}`}
                empty="Nothing scores above the candidate floor. Categorise this line to an account instead."
                columns={[
                  { key: 'type', header: 'Type', render: (row) => row.target_type.toLowerCase() },
                  { key: 'reference', header: 'Reference', render: (row) => row.reference ?? '—' },
                  {
                    key: 'counterparty',
                    header: 'Counterparty',
                    render: (row) => row.counterparty ?? '—',
                  },
                  {
                    key: 'amount',
                    header: 'Outstanding',
                    numeric: true,
                    render: (row) => money(row.amount),
                  },
                  {
                    key: 'score',
                    header: 'Score',
                    numeric: true,
                    render: (row) => `${(row.score * 100).toFixed(0)}%`,
                  },
                  {
                    key: 'why',
                    header: 'Why',
                    // The argument, not the verdict. "Amount exact, reference
                    // matched" is checkable by the person confirming it; a bare
                    // percentage is not.
                    render: (row) =>
                      Object.entries(row.factors)
                        .filter(([, weight]) => weight > 0.5)
                        .map(([factor]) => factor.replace(/([A-Z])/g, ' $1').toLowerCase())
                        .join(', ') || 'weak on every factor',
                  },
                  {
                    key: 'auto',
                    header: 'Auto-matchable',
                    render: (row) =>
                      row.auto_matchable ? 'yes' : row.exact ? 'exact, below threshold' : 'no',
                  },
                  {
                    key: 'confirm',
                    header: 'Confirm',
                    render: (row) =>
                      can('bank.reconcile') ? (
                        <Button variant="primary" busy={busy} onClick={() => confirmMatch(row)}>
                          Confirm
                        </Button>
                      ) : (
                        <span className="field-hint">needs bank.reconcile</span>
                      ),
                  },
                ]}
              />
              <Button onClick={() => setSelected(null)}>Close</Button>
            </div>
          ) : null}

          {can('bank.import') ? (
            <form onSubmit={runImport} className="card">
              <h2>Import a statement</h2>
              <Field
                label="Format"
                name="format"
                value={importFormat}
                onChange={setImportFormat}
                required
                options={['CSV', 'OFX', 'QFX', 'QIF'].map((f) => ({ value: f, label: f }))}
                hint="MT940 and CAMT053 are refused for now, with the reason — they are region-specific and the first release is generic."
              />
              <div className="field">
                <label htmlFor="statement-content">Statement contents</label>
                <textarea
                  id="statement-content"
                  name="content"
                  rows={8}
                  value={importContent}
                  onChange={(event) => setImportContent(event.target.value)}
                  required
                />
                <p className="field-hint">
                  Re-importing the same file is safe and imports nothing the second time. Two
                  genuinely identical same-day lines are both imported, with the second flagged for
                  review rather than dropped.
                </p>
              </div>
              <Button type="submit" variant="primary" busy={busy}>
                Import
              </Button>
            </form>
          ) : null}
        </>
      ) : (
        <p className="empty">Choose a bank account to see its transactions.</p>
      )}
    </>
  );
}
