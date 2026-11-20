import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useRuns, useStats, useWorkflows } from "../api/hooks";
import type { Window } from "../api/types";
import {
  ChartTooltip,
  Empty,
  ErrorNotice,
  Loading,
  Readout,
  StatusKnot,
  WindowSwitcher,
} from "../components/parts";
import { formatAgo, formatCount, formatDateTime, formatDuration, formatTick } from "../lib/format";

const REDUCED_MOTION =
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Overview() {
  const [range, setRange] = useState<Window>("24h");
  const stats = useStats(range);
  const workflows = useWorkflows();
  const failed = useRuns({ status: "failed" });
  const recentFailures = useMemo(
    () => failed.data?.pages[0]?.items.slice(0, 5) ?? [],
    [failed.data],
  );
  const totals = stats.data?.totals;
  const rangeLabel = { "1h": "the last hour", "24h": "the last 24 hours", "7d": "the last 7 days" }[
    range
  ];

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1>Overview</h1>
          <p className="page__lede">
            What your workflows did over {rangeLabel}, and what is in flight right now.
          </p>
        </div>
        <WindowSwitcher value={range} onChange={setRange} />
      </header>

      {stats.isError ? <ErrorNotice error={stats.error} /> : null}
      {stats.isPending ? <Loading what="the overview" /> : null}

      {totals ? (
        <>
          <section className="readouts" aria-label="Summary">
            <Readout label="Started" value={formatCount(totals.started)} />
            <Readout label="Completed" value={formatCount(totals.completed)} />
            <Readout
              label="Failed"
              value={formatCount(totals.failed)}
              tone={totals.failed > 0 ? "madder" : undefined}
            />
            <Readout label="Running now" value={formatCount(totals.running + totals.queued)} />
            <Readout
              label="Sleeping or waiting"
              value={formatCount(totals.sleeping + totals.waiting)}
            />
          </section>

          {totals.started === 0 && totals.running + totals.sleeping + totals.waiting === 0 ? (
            <Empty title={`No runs in ${rangeLabel}`}>
              <p>Start a workflow and it shows up here. Try the order-fulfillment example.</p>
              <pre className="snippet">pnpm --filter @strand/example-order-fulfillment orders</pre>
            </Empty>
          ) : (
            <section className="section">
              <div className="section__head">
                <h2>Runs over time</h2>
                <div className="legend">
                  <span className="legend__item">
                    <span className="legend__swatch" style={{ background: "var(--moss)" }} />
                    Completed
                  </span>
                  <span className="legend__item">
                    <span className="legend__swatch" style={{ background: "var(--madder)" }} />
                    Failed
                  </span>
                  <span className="legend__item">
                    <span className="legend__swatch" style={{ background: "var(--indigo)" }} />
                    Started
                  </span>
                </div>
              </div>
              <div className="chart">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={stats.data?.series}
                    margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
                    barCategoryGap="20%"
                  >
                    <CartesianGrid
                      vertical={false}
                      stroke="var(--rule-soft)"
                      strokeDasharray="2 4"
                    />
                    <XAxis
                      dataKey="ts"
                      tickFormatter={(v: string) => formatTick(v, range)}
                      tickLine={false}
                      axisLine={{ stroke: "var(--rule)" }}
                      minTickGap={56}
                      tick={{ fill: "var(--ink-2)", fontSize: 12 }}
                    />
                    <YAxis
                      allowDecimals={false}
                      tickLine={false}
                      axisLine={false}
                      width={40}
                      tick={{ fill: "var(--ink-2)", fontSize: 12 }}
                    />
                    <Tooltip
                      cursor={{ fill: "var(--hover)" }}
                      content={({ active, payload }) => {
                        const point = payload?.[0]?.payload as
                          | { ts: string; started: number; completed: number; failed: number }
                          | undefined;
                        if (!active || !point) return null;
                        return (
                          <ChartTooltip
                            title={formatDateTime(point.ts)}
                            rows={[
                              {
                                name: "Started",
                                value: String(point.started),
                                color: "var(--indigo)",
                              },
                              {
                                name: "Completed",
                                value: String(point.completed),
                                color: "var(--moss)",
                              },
                              {
                                name: "Failed",
                                value: String(point.failed),
                                color: "var(--madder)",
                              },
                            ]}
                          />
                        );
                      }}
                    />
                    <Bar
                      dataKey="completed"
                      stackId="done"
                      fill="var(--moss)"
                      isAnimationActive={!REDUCED_MOTION}
                      animationDuration={700}
                    />
                    <Bar
                      dataKey="failed"
                      stackId="done"
                      fill="var(--madder)"
                      isAnimationActive={!REDUCED_MOTION}
                      animationDuration={700}
                    />
                    <Line
                      dataKey="started"
                      stroke="var(--indigo)"
                      strokeWidth={2}
                      dot={false}
                      type="monotone"
                      isAnimationActive={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          <div className="split">
            <section className="section">
              <h2>Workflows, last 24 hours</h2>
              {workflows.isError ? <ErrorNotice error={workflows.error} /> : null}
              {workflows.data && workflows.data.length === 0 ? (
                <p className="muted">No workflow has run in the last 24 hours.</p>
              ) : null}
              {workflows.data && workflows.data.length > 0 ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Workflow</th>
                        <th scope="col" className="table__num">
                          Runs
                        </th>
                        <th scope="col" className="table__num">
                          Failed
                        </th>
                        <th scope="col" className="table__num">
                          Median
                        </th>
                        <th scope="col" className="table__num">
                          p95
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {workflows.data.map((w) => (
                        <tr key={w.workflow} className="table__row">
                          <th scope="row">
                            <Link
                              to={`/runs?workflow=${encodeURIComponent(w.workflow)}`}
                              className="table__link"
                            >
                              {w.workflow}
                            </Link>
                          </th>
                          <td className="table__num">{formatCount(w.total)}</td>
                          <td className="table__num">{w.failed}</td>
                          <td className="table__num">
                            {w.p50Ms === null ? "" : formatDuration(w.p50Ms)}
                          </td>
                          <td className="table__num">
                            {w.p95Ms === null ? "" : formatDuration(w.p95Ms)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>

            <section className="section">
              <h2>Recent failures</h2>
              {recentFailures.length === 0 ? (
                <p className="muted">
                  Nothing has failed. Runs that exhaust their retries will appear here.
                </p>
              ) : (
                <ul
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}
                >
                  {recentFailures.map((run) => (
                    <li key={run.id}>
                      <StatusKnot status={run.status} />{" "}
                      <Link to={`/runs/${run.id}`}>{run.workflow}</Link>{" "}
                      <span className="muted">{formatAgo(run.updatedAt)}</span>
                      {run.error ? (
                        <p className="muted" style={{ marginLeft: 19 }}>
                          {run.error.message}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
