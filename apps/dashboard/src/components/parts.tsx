import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { ApiError } from "../api/client";
import type { RunStatus, Window } from "../api/types";

export function StatusKnot({ status }: { status: RunStatus }) {
  return <span className={`knot knot--${status}`}>{status}</span>;
}

export function Readout({ label, value, tone }: { label: string; value: string; tone?: "madder" }) {
  return (
    <div className="readout">
      <span className="readout__label">{label}</span>
      <span className={`readout__value${tone ? ` readout__value--${tone}` : ""}`}>{value}</span>
    </div>
  );
}

const WINDOWS: { value: Window; label: string }[] = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
];

export function WindowSwitcher({
  value,
  onChange,
}: {
  value: Window;
  onChange: (w: Window) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label="Time window">
      {WINDOWS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__option"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children ? <div className="muted">{children}</div> : null}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="muted" role="status">
      Loading {what}
    </p>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <div className="notice notice--madder" role="alert">
        <p className="notice__title">This token can't open the dashboard</p>
        <p className="notice__body">
          Check the API token in <Link to="/settings">Settings</Link>.
        </p>
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="notice notice--saffron" role="alert">
        <p className="notice__title">Not found</p>
        <p className="notice__body">{error.message}</p>
      </div>
    );
  }
  return (
    <div className="notice notice--madder" role="alert">
      <p className="notice__title">Couldn't load this data</p>
      <p className="notice__body">
        {error instanceof Error ? error.message : "Something went wrong."}
      </p>
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="block">{JSON.stringify(value, null, 2) ?? "null"}</pre>;
}

export function ChartTooltip({
  title,
  rows,
}: {
  title: string;
  rows: { name: string; value: string; color: string }[];
}) {
  return (
    <div className="tooltip">
      <p style={{ fontWeight: 600, marginBottom: 4 }}>{title}</p>
      {rows.map((row) => (
        <div className="tooltip__row" key={row.name}>
          <span>
            <span
              className="legend__swatch"
              style={{ background: row.color, display: "inline-block", marginRight: 6 }}
            />
            {row.name}
          </span>
          <span>{row.value}</span>
        </div>
      ))}
    </div>
  );
}
