import type { LedgerRow } from "../core/ledger";

const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;

export function RowsTable({ rows }: { rows: LedgerRow[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Recipient</th>
            <th className="num">Amount (USDC)</th>
            <th>Reference</th>
            <th>Status</th>
            <th>Transaction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.memoId}>
              <td>{r.index + 1}</td>
              <td className="mono" title={r.recipient}>
                {short(r.recipient)}
              </td>
              <td className="num mono">{r.amount}</td>
              <td className="mono">{r.reference}</td>
              <td>
                <span className={`status status-${r.status}`}>{r.status}</span>
                {r.error ? <div className="row-error">{r.error}</div> : null}
              </td>
              <td className="mono">
                {r.txHash && r.explorerUrl ? (
                  <a href={r.explorerUrl} target="_blank" rel="noreferrer">
                    {short(r.txHash)}
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
