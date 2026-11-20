import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";

import { useRun, useRunActions } from "../api/hooks";
import type { Run, RunEvent } from "../api/types";
import { ErrorNotice, JsonBlock, Loading, StatusKnot } from "../components/parts";
import { formatDateTime, formatDuration, shortId, shortWorker } from "../lib/format";
import { buildTimeline, type TimelineRecovery, type TimelineRow } from "../lib/timeline";

const FINISHED = new Set(["completed", "failed", "cancelled"]);

function RowItem({ row }: { row: TimelineRow }) {
  const kindLabel =
    row.kind === "sleep"
      ? "Sleep"
      : row.kind === "wait"
        ? `Waiting for ${row.signal ?? "a signal"}`
        : null;
  const lastError = row.error?.message;

  return (
    <li className={`timeline__item timeline__item--${row.status} timeline__item--${row.kind}`}>
      <span className="timeline__node" aria-hidden="true" />
      <div>
        <div className="timeline__name">{row.key}</div>
        <div className="timeline__kind">
          {kindLabel ??
            (row.status === "completed"
              ? "Completed"
              : row.status === "failed"
                ? "Failed"
                : "Retrying")}
        </div>
      </div>
      <div className="timeline__track" aria-hidden="true">
        <div
          className={`timeline__bar${row.ongoing ? " timeline__bar--ongoing" : ""}`}
          style={{ "--w": row.width } as React.CSSProperties}
        />
      </div>
      <div className="timeline__meta">
        <span>{formatDuration(row.durationMs)}</span>
        {row.kind === "step" ? (
          <span>
            {row.attempts} {row.attempts === 1 ? "attempt" : "attempts"}
          </span>
        ) : null}
        {row.retries.length > 0 ? <span>{row.retries.length} retried</span> : null}
        {row.output !== null && row.output !== undefined && row.kind === "step" ? (
          <details>
            <summary>Result</summary>
            <JsonBlock value={row.output} />
          </details>
        ) : null}
      </div>
      {lastError ? <p className="timeline__error">{lastError}</p> : null}
    </li>
  );
}

function RecoveryItem({ recovery }: { recovery: TimelineRecovery }) {
  return (
    <li className="timeline__item timeline__item--recovery">
      <span className="timeline__break" aria-hidden="true" />
      Lease expired after {formatDuration(recovery.atMs)}.{" "}
      <span>
        {recovery.previousOwner ? shortWorker(recovery.previousOwner) : "A worker"} stopped
        responding; {recovery.nextOwner ? shortWorker(recovery.nextOwner) : "another worker"}{" "}
        resumed the run from its last completed step.
      </span>
    </li>
  );
}

function SignalForm({
  defaultName,
  onSend,
  pending,
}: {
  defaultName: string;
  onSend: (name: string, payload: unknown) => void;
  pending: boolean;
}) {
  const [name, setName] = useState(defaultName);
  const [payload, setPayload] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    let parsed: unknown = null;
    if (payload.trim()) {
      try {
        parsed = JSON.parse(payload);
      } catch {
        setProblem('The payload must be valid JSON, for example {"ok": true}.');
        return;
      }
    }
    setProblem(null);
    onSend(name.trim(), parsed);
  };

  return (
    <form className="section" onSubmit={submit}>
      <div className="row">
        <label className="field">
          Signal name
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="field" style={{ flex: "1 1 280px" }}>
          Payload (JSON, optional)
          <textarea
            className="input"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            placeholder='{"ok": true}'
          />
        </label>
        <button type="submit" className="button" disabled={pending || !name.trim()}>
          Send signal
        </button>
      </div>
      {problem ? (
        <p className="notice notice--madder" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

export function RunDetail() {
  const { id = "" } = useParams();
  const query = useRun(id);
  const actions = useRunActions(id);
  const [signalOpen, setSignalOpen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const detail = query.data;
  const timeline = useMemo(
    () => (detail ? buildTimeline(detail.run, detail.steps, detail.events) : null),
    [detail],
  );

  if (query.isError) {
    return (
      <div className="page">
        <ErrorNotice error={query.error} />
        <Link to="/runs">Back to runs</Link>
      </div>
    );
  }
  if (!detail || !timeline) {
    return (
      <div className="page">
        <Loading what="the run" />
      </div>
    );
  }

  const { run, events } = detail;
  // Consecutive claims by the same worker (after a sleep or retry) read as one chip.
  const chain = timeline.owners.filter((owner, i, all) => owner !== all[i - 1]);
  const handovers = timeline.items.filter((item) => item.type === "recovery").length;
  const finished = FINISHED.has(run.status);
  const failure = actions.cancel.error ?? actions.retry.error ?? actions.signal.error;
  const duration = run.completedAt
    ? Date.parse(run.completedAt) - Date.parse(run.createdAt)
    : timeline.totalMs;

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <p className="muted">
            <Link to="/runs">Runs</Link> / <span className="code">{shortId(run.id)}</span>
          </p>
          <h1>{run.workflow}</h1>
          <p style={{ marginTop: 8 }}>
            <StatusKnot status={run.status} />
            {run.status === "waiting" && run.waitingSignal ? (
              <span className="muted"> for the signal “{run.waitingSignal}”</span>
            ) : null}
          </p>
        </div>
        <div className="row">
          {!finished ? (
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setSignalOpen((open) => !open)}
            >
              {signalOpen ? "Hide signal form" : "Send a signal"}
            </button>
          ) : null}
          {run.status === "failed" ? (
            <button
              type="button"
              className="button"
              disabled={actions.retry.isPending}
              onClick={() => actions.retry.mutate()}
            >
              Retry from the failed step
            </button>
          ) : null}
          {!finished ? (
            confirmCancel ? (
              <button
                type="button"
                className="button button--danger"
                disabled={actions.cancel.isPending}
                onClick={() => {
                  actions.cancel.mutate();
                  setConfirmCancel(false);
                }}
              >
                Confirm: cancel this run
              </button>
            ) : (
              <button
                type="button"
                className="button button--quiet"
                onClick={() => setConfirmCancel(true)}
              >
                Cancel run
              </button>
            )
          ) : null}
        </div>
      </header>

      {failure ? <ErrorNotice error={failure} /> : null}
      {signalOpen && !finished ? (
        <SignalForm
          defaultName={run.waitingSignal ?? ""}
          pending={actions.signal.isPending}
          onSend={(name, payload) =>
            actions.signal.mutate({ name, payload }, { onSuccess: () => setSignalOpen(false) })
          }
        />
      ) : null}

      {run.error ? (
        <div className="notice notice--madder" role="alert">
          <p className="notice__title">{run.error.name}</p>
          <p className="notice__body">{run.error.message}</p>
        </div>
      ) : null}

      <section className="section" aria-label="Summary">
        <dl className="facts">
          <dt>Started</dt>
          <dd>{formatDateTime(run.createdAt)}</dd>
          <dt>{finished ? "Took" : "Running for"}</dt>
          <dd>{formatDuration(duration)}</dd>
          <dt>Claimed by</dt>
          <dd>
            {timeline.owners.length === 0 ? (
              <span className="muted">No worker yet</span>
            ) : (
              <span className="owners">
                {chain.map((owner, index) => (
                  <span key={`${owner}-${index}`} className="owners__chip">
                    {shortWorker(owner)}
                  </span>
                ))}
                <span className="muted">
                  {timeline.owners.length} {timeline.owners.length === 1 ? "claim" : "claims"}
                  {handovers > 0
                    ? `, including ${handovers} ${handovers === 1 ? "handover" : "handovers"} after a worker stopped responding`
                    : ""}
                </span>
              </span>
            )}
          </dd>
          {run.idempotencyKey ? (
            <>
              <dt>Idempotency key</dt>
              <dd className="code">{run.idempotencyKey}</dd>
            </>
          ) : null}
          {run.scheduleId ? (
            <>
              <dt>Started by schedule</dt>
              <dd>{run.scheduleId}</dd>
            </>
          ) : null}
        </dl>
      </section>

      <section className="section" aria-label="Timeline">
        <div className="section__head">
          <h2>Timeline</h2>
          <span className="muted">
            Bar length is logarithmic, so milliseconds and days fit on one line.
          </span>
        </div>
        {timeline.items.length === 0 ? (
          <p className="muted">No steps have run yet.</p>
        ) : (
          <ol className="timeline">
            <span className="timeline__thread" aria-hidden="true" />
            {timeline.items.map((item, index) =>
              item.type === "row" ? (
                <RowItem key={item.key} row={item} />
              ) : (
                <RecoveryItem key={`r${index}`} recovery={item} />
              ),
            )}
          </ol>
        )}
      </section>

      <div className="split">
        <section className="section">
          <h2>Input</h2>
          <JsonBlock value={run.input} />
        </section>
        <section className="section">
          <h2>Output</h2>
          {run.status === "completed" ? (
            <JsonBlock value={run.output} />
          ) : (
            <p className="muted">Available once the run completes.</p>
          )}
        </section>
      </div>

      <EventLog run={run} events={events} />
    </div>
  );
}

function EventLog({ run, events }: { run: Run; events: RunEvent[] }) {
  const t0 = Date.parse(run.createdAt);
  return (
    <section className="section">
      <details>
        <summary>Event log ({events.length})</summary>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">After</th>
                <th scope="col">Event</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{formatDuration(Date.parse(event.at) - t0)}</td>
                  <td className="code">{event.type}</td>
                  <td className="muted" style={{ whiteSpace: "normal" }}>
                    {Object.entries(event.data)
                      .map(
                        ([key, value]) =>
                          `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
                      )
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
