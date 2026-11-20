import { useWorkers } from "../api/hooks";
import { Empty, ErrorNotice, Loading } from "../components/parts";
import { formatAgo } from "../lib/format";

export function Workers() {
  const workers = useWorkers();
  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1>Workers</h1>
          <p className="page__lede">
            Processes that claim and run workflows. A worker that hasn't checked in for 30 seconds
            is shown as down; its runs are picked up by the others.
          </p>
        </div>
      </header>

      {workers.isError ? <ErrorNotice error={workers.error} /> : null}
      {workers.isPending ? <Loading what="workers" /> : null}

      {workers.data && workers.data.length === 0 ? (
        <Empty title="No workers have registered">
          <p>Start a worker and it appears here. Runs stay queued until one is running.</p>
        </Empty>
      ) : null}

      {workers.data && workers.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Worker</th>
                <th scope="col">Status</th>
                <th scope="col">Host</th>
                <th scope="col">Workflows</th>
                <th scope="col" className="table__num">
                  Concurrency
                </th>
                <th scope="col">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {workers.data.map((w) => (
                <tr key={w.id} className="table__row">
                  <th scope="row" className="code">
                    {w.id}
                  </th>
                  <td>
                    <span className={`knot ${w.alive ? "knot--alive" : "knot--down"}`}>
                      {w.alive ? "alive" : "down"}
                    </span>
                  </td>
                  <td>
                    {w.hostname} <span className="muted">pid {w.pid}</span>
                  </td>
                  <td style={{ whiteSpace: "normal" }}>{w.workflows.join(", ")}</td>
                  <td className="table__num">{w.concurrency}</td>
                  <td>{formatAgo(w.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
