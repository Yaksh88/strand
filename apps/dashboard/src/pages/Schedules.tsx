import { useState, type FormEvent } from "react";

import { useSchedulePreview, useScheduleActions, useSchedules } from "../api/hooks";
import { Empty, ErrorNotice, Loading } from "../components/parts";
import { formatAgo, formatDateTime } from "../lib/format";

export function Schedules() {
  const schedules = useSchedules();
  const { save, remove } = useScheduleActions();
  const [form, setForm] = useState({ id: "", workflow: "", cron: "0 9 * * *", timezone: "UTC" });
  const preview = useSchedulePreview(form.cron, form.timezone);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(form, { onSuccess: () => setForm((f) => ({ ...f, id: "" })) });
  };

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1>Schedules</h1>
          <p className="page__lede">
            Cron schedules that start a workflow on a timer. Exactly one worker fires them, and a
            slot can never start twice.
          </p>
        </div>
      </header>

      <section className="section">
        <h2>Add a schedule</h2>
        <form onSubmit={submit} className="section">
          <div className="row">
            <label className="field">
              Name
              <input
                className="input"
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
                required
                placeholder="nightly-report"
              />
            </label>
            <label className="field">
              Workflow
              <input
                className="input"
                value={form.workflow}
                onChange={(e) => setForm({ ...form, workflow: e.target.value })}
                required
                placeholder="daily-report"
              />
            </label>
            <label className="field">
              Cron expression
              <input
                className="input code"
                value={form.cron}
                onChange={(e) => setForm({ ...form, cron: e.target.value })}
                required
              />
            </label>
            <label className="field">
              Time zone
              <input
                className="input"
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                required
              />
            </label>
            <button type="submit" className="button" disabled={save.isPending}>
              Save schedule
            </button>
          </div>
          {preview.isError ? (
            <p className="notice notice--madder" role="alert">
              {preview.error.message}
            </p>
          ) : preview.data ? (
            <p className="muted">
              Next runs:{" "}
              {preview.data.next
                .slice(0, 3)
                .map((t) => formatDateTime(t))
                .join(", ")}{" "}
              …
            </p>
          ) : null}
          {save.isError ? <ErrorNotice error={save.error} /> : null}
        </form>
      </section>

      <section className="section">
        <h2>Schedules</h2>
        {schedules.isError ? <ErrorNotice error={schedules.error} /> : null}
        {schedules.isPending ? <Loading what="schedules" /> : null}
        {schedules.data && schedules.data.length === 0 ? (
          <Empty title="No schedules yet">
            <p>
              Add one above, or create it from code with <code>client.upsertSchedule</code>.
            </p>
          </Empty>
        ) : null}
        {schedules.data && schedules.data.length > 0 ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Workflow</th>
                  <th scope="col">Cron</th>
                  <th scope="col">Time zone</th>
                  <th scope="col">Next run</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {schedules.data.map((s) => (
                  <tr key={s.id} className="table__row">
                    <th scope="row">{s.id}</th>
                    <td>{s.workflow}</td>
                    <td className="code">{s.cron}</td>
                    <td>{s.timezone}</td>
                    <td title={formatDateTime(s.nextFireAt)}>
                      {s.enabled ? formatAgo(s.nextFireAt) : <span className="muted">paused</span>}
                    </td>
                    <td className="table__num">
                      <button
                        type="button"
                        className="button button--quiet"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(s.id)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
