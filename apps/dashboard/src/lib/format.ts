const whole = new Intl.NumberFormat("en");
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export const formatCount = (n: number): string =>
  n < 10_000 ? whole.format(n) : compact.format(n);

/** 120 ms, 4.2 s, 3m 20s, 2h 5m, 3d 4h: two units at most, so it stays readable at any scale. */
export function formatDuration(ms: number): string {
  if (ms < 1) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });

export function formatAgo(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return seconds > 0 ? "in a moment" : "just now";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  return relative.format(Math.round(seconds / 86_400), "day");
}

export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export const formatTick = (iso: string, window: "1h" | "24h" | "7d"): string => {
  const date = new Date(iso);
  return window === "7d"
    ? date.toLocaleDateString("en", { weekday: "short", day: "numeric" })
    : date.toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });
};

export const shortId = (id: string): string => id.slice(0, 8);

/** Worker ids look like host:pid:suffix; the host is the same everywhere, so show the rest. */
export function shortWorker(id: string): string {
  const parts = id.split(":");
  return parts.length >= 3 ? parts.slice(1).join(":") : id;
}
