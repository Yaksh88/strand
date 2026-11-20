import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { useRuns, useWorkflows } from "../api/hooks";
import type { RunFilters, RunStatus } from "../api/types";
import { Empty, ErrorNotice, Loading, StatusKnot } from "../components/parts";
import { formatAgo, formatDateTime, formatDuration, shortId } from "../lib/format";

const STATUSES: (RunStatus | "all")[] = [
  "all",
  "running",
  "waiting",
  "sleeping",
  "queued",
  "failed",
  "completed",
  "cancelled",
];

export function Runs() {
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<RunFilters>(() => {
    const status = params.get("status") as RunStatus | null;
    return {
      ...(params.get("workflow") ? { workflow: params.get("workflow") as string } : {}),
      ...(status && STATUSES.includes(status) ? { status } : {}),
    };
  });
  const runs = useRuns(filters);
  const workflows = useWorkflows();
  const rows = useMemo(() => runs.data?.pages.flatMap((page) => page.items) ?? [], [runs.data]);
  const filtered = Boolean(filters.status || filters.workflow);

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1>Runs</h1>
          <p className="page__lede">
            Every workflow run, newest first. Select one to see its timeline.
          </p>
        </div>
        <label className="field">
          Workflow
          <select
            className="input"
            value={filters.workflow ?? ""}
            onChange={(e) => setFilters((f) => ({ ...f, workflow: e.target.value || undefined }))}
          >
            <option value="">All workflows</option>
            {workflows.data?.map((w) => (
              <option key={w.workflow} value={w.workflow}>
                {w.workflow}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="chips" role="group" aria-label="Filter by status">
        {STATUSES.map((status) => (
          <button
            key={status}
            type="button"
            className="chip"
            aria-pressed={(filters.status ?? "all") === status}
            onClick={() =>
              setFilters((f) => ({ ...f, status: status === "all" ? undefined : status }))
            }
          >
            {status === "all" ? "All" : status}
          </button>
        ))}
      </div>

      {runs.isError ? <ErrorNotice error={runs.error} /> : null}
      {runs.isPending ? <Loading what="runs" /> : null}

      {runs.data && rows.length === 0 ? (
        <Empty title={filtered ? "No runs match these filters" : "No runs yet"}>
          {filtered ? (
            <button type="button" className="button button--quiet" onClick={() => setFilters({})}>
              Clear filters
            </button>
          ) : (
            <p>
              Start one with the client, or <code>POST /v1/runs</code>, and it appears here.
            </p>
          )}
        </Empty>
      ) : null}

      {rows.length > 0 ? (
        <section className="section" aria-label="Run list">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Workflow</th>
                  <th scope="col">Run</th>
                  <th scope="col">Started</th>
                  <th scope="col" className="table__num">
                    Took
                  </th>
                  <th scope="col" className="table__num">
                    Claims
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((run) => (
                  <tr key={run.id} className="table__row">
                    <td>
                      <StatusKnot status={run.status} />
                    </td>
                    <th scope="row">
                      <Link to={`/runs/${run.id}`} className="table__link">
                        {run.workflow}
                      </Link>
                    </th>
                    <td className="code muted">{shortId(run.id)}</td>
                    <td title={formatDateTime(run.createdAt)}>{formatAgo(run.createdAt)}</td>
                    <td className="table__num">
                      {run.durationMs === null ? "" : formatDuration(run.durationMs)}
                    </td>
                    <td
                      className="table__num"
                      title="Times a worker claimed this run. It is claimed again after each sleep, signal wait or retry."
                    >
                      {run.claimCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {runs.hasNextPage ? (
            <div>
              <button
                type="button"
                className="button button--quiet"
                onClick={() => void runs.fetchNextPage()}
                disabled={runs.isFetchingNextPage}
              >
                {runs.isFetchingNextPage ? "Loading more" : "Load more"}
              </button>
            </div>
          ) : (
            <p className="muted">That's every run.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
