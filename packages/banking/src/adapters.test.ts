import { describe, it, expect } from 'vitest';
import { parseStatement, splitCsvLine } from './adapters';

describe('splitCsvLine', () => {
  it('honours quotes, embedded commas and doubled quotes', () => {
    expect(splitCsvLine('a,"b,c","say ""hi""",d')).toEqual(['a', 'b,c', 'say "hi"', 'd']);
  });

  it('keeps empty trailing cells', () => {
    expect(splitCsvLine('a,,')).toEqual(['a', '', '']);
  });
});

describe('CSV import', () => {
  const csv = (body: string) => parseStatement({ format: 'CSV', currency: 'USD', content: body });

  it('reads columns by name, not position', () => {
    // The point of the design: a bank that reorders its export still imports.
    const a = csv('Date,Amount,Description\n2026-03-01,100.00,Deposit');
    const b = csv('Description,Date,Amount\nDeposit,2026-03-01,100.00');
    expect(a.transactions[0]!.amount.toString()).toBe(b.transactions[0]!.amount.toString());
    expect(a.transactions[0]!.description).toBe(b.transactions[0]!.description);
  });

  it('accepts the debit/credit shape and signs it', () => {
    const s = csv('Date,Paid out,Paid in\n2026-03-01,,250.00\n2026-03-02,80.00,');
    expect(s.transactions[0]!.amount.toString()).toBe('250.00');
    expect(s.transactions[1]!.amount.toString()).toBe('-80.00');
  });

  it('refuses a row that populates both debit and credit', () => {
    // Not a row to guess at: the direction is genuinely ambiguous.
    expect(() => csv('Date,Debit,Credit\n2026-03-01,10.00,20.00')).toThrow(/ambiguous/);
  });

  it('strips thousands separators and currency symbols', () => {
    expect(csv('Date,Amount\n2026-03-01,"$1,234.56"').transactions[0]!.amount.toString()).toBe(
      '1234.56',
    );
  });

  it('reads the European 1.234,56 form without mangling it', () => {
    expect(csv('Date,Amount\n2026-03-01,"1.234,56"').transactions[0]!.amount.toString()).toBe(
      '1234.56',
    );
  });

  it('names the missing column rather than failing obscurely', () => {
    expect(() => csv('Date,Narrative\n2026-03-01,Deposit')).toThrow(/does not name amount/);
  });

  it('refuses a zero-amount row, which is not a cash movement', () => {
    expect(() => csv('Date,Amount\n2026-03-01,0.00')).toThrow(/zero amount/);
  });

  it('reads DD/MM/YYYY and refuses a month above twelve rather than guessing', () => {
    expect(csv('Date,Amount\n01/03/2026,10.00').transactions[0]!.transactionDate).toBe(
      '2026-03-01',
    );
    // 13 cannot be a month, so this file is MM/DD and we will not silently
    // reinterpret it — a statement three months out is worse than a refusal.
    expect(() => csv('Date,Amount\n03/13/2026,10.00')).toThrow(/month above 12/);
  });

  it('derives the statement period from the rows it read', () => {
    const s = csv('Date,Amount\n2026-03-05,10.00\n2026-03-01,20.00\n2026-03-31,30.00');
    expect(s.periodStart).toBe('2026-03-01');
    expect(s.periodEnd).toBe('2026-03-31');
  });

  it('refuses an empty file', () => {
    expect(() => csv('')).toThrow(/empty/);
  });
});

describe('OFX import', () => {
  const ofx = `
    <OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
      <BANKTRANLIST>
        <STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260301120000[0:GMT]<TRNAMT>-45.20
          <FITID>2026030100001<NAME>ACME Corp<MEMO>Card payment</STMTTRN>
        <STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260302<TRNAMT>1200.00
          <FITID>2026030200002<NAME>Globex<MEMO>INV-42</STMTTRN>
      </BANKTRANLIST>
      <LEDGERBAL><BALAMT>5000.00<DTASOF>20260302</LEDGERBAL>
    </STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

  it('takes FITID as the provider transaction id', () => {
    // OFX's FITID is doc 06's primary dedupe key. Losing it would drop every
    // import to the fingerprint fallback.
    const s = parseStatement({ format: 'OFX', currency: 'USD', content: ofx });
    expect(s.transactions.map((t) => t.providerTransactionId)).toEqual([
      '2026030100001',
      '2026030200002',
    ]);
  });

  it('parses the timestamped date form and keeps the sign', () => {
    const s = parseStatement({ format: 'OFX', currency: 'USD', content: ofx });
    expect(s.transactions[0]!.transactionDate).toBe('2026-03-01');
    expect(s.transactions[0]!.amount.toString()).toBe('-45.20');
  });

  it('reads the ledger balance as the closing balance', () => {
    expect(parseStatement({ format: 'OFX', currency: 'USD', content: ofx }).closingBalance).toBe(
      '5000.00',
    );
  });

  it('refuses a file with no transaction blocks', () => {
    expect(() =>
      parseStatement({ format: 'OFX', currency: 'USD', content: '<OFX></OFX>' }),
    ).toThrow(/does not look like an OFX/);
  });
});

describe('QIF import', () => {
  const qif = `!Type:Bank
D03/01/2026
T-45.20
PACME Corp
MCard payment
^
D03/02/2026
T1200.00
PGlobex
MINV-42
^`;

  it('parses records and normalises the US month-first date', () => {
    const s = parseStatement({ format: 'QIF', currency: 'USD', content: qif });
    expect(s.transactions).toHaveLength(2);
    expect(s.transactions[0]!.transactionDate).toBe('2026-03-01');
    expect(s.transactions[1]!.amount.toString()).toBe('1200.00');
  });

  it('leaves the provider id null, because QIF has none', () => {
    // Which is why the fingerprint index is not unique: re-importing a QIF must
    // raise review items rather than silently drop a real second transaction.
    const s = parseStatement({ format: 'QIF', currency: 'USD', content: qif });
    expect(s.transactions.every((t) => t.providerTransactionId === null)).toBe(true);
  });

  it('refuses a file with no complete records', () => {
    expect(() =>
      parseStatement({ format: 'QIF', currency: 'USD', content: 'PNo date\n^' }),
    ).toThrow(/No QIF records/);
  });
});

describe('API and processor rows', () => {
  it('passes canonical rows through with their provider ids', () => {
    const s = parseStatement({
      format: 'API',
      currency: 'GBP',
      rows: [
        { providerTransactionId: 'tx_1', date: '2026-03-01', amount: '10.00', balance: '110.00' },
      ],
    });
    expect(s.transactions[0]!.providerTransactionId).toBe('tx_1');
    expect(s.closingBalance).toBe('110.00');
    expect(s.transactions[0]!.currency).toBe('GBP');
  });

  it('refuses an empty import', () => {
    expect(() => parseStatement({ format: 'API', currency: 'GBP', rows: [] })).toThrow(
      /at least one transaction/,
    );
  });
});

describe('unimplemented statement standards', () => {
  it.each(['MT940', 'CAMT053'] as const)('refuses %s with the reason, not silently', (format) => {
    // doc 06 scopes these "by geography" and the first release is generic/global.
    // A parser that returned zero transactions would look like an empty statement.
    expect(() => parseStatement({ format, currency: 'EUR', content: 'anything' })).toThrow(
      /geography-specific/,
    );
  });
});
