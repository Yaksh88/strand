import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { api } from "./client";
import type {
  Run,
  RunDetail,
  RunFilters,
  RunPage,
  Schedule,
  Stats,
  Window,
  Worker,
  WorkflowSummary,
} from "./types";

const ACTIVE = new Set(["queued", "running", "sleeping", "waiting"]);

export const useStats = (window: Window) =>
  useQuery({
    queryKey: ["stats", window],
    queryFn: () => api<Stats>("/v1/stats", { params: { window } }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

export const useWorkflows = () =>
  useQuery({
    queryKey: ["workflows"],
    queryFn: () => api<WorkflowSummary[]>("/v1/workflows"),
    refetchInterval: 10_000,
  });

export const useWorkers = () =>
  useQuery({
    queryKey: ["workers"],
    queryFn: () => api<Worker[]>("/v1/workers"),
    refetchInterval: 5_000,
  });

export const useRuns = (filters: RunFilters) =>
  useInfiniteQuery({
    queryKey: ["runs", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<RunPage>("/v1/runs", { params: { ...filters, limit: 50, before: pageParam } }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 5_000,
  });

/** One run with its steps and events; polls while the run is still moving. */
export const useRun = (id: string) =>
  useQuery({
    queryKey: ["run", id],
    queryFn: () => api<RunDetail>(`/v1/runs/${id}`),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status && !ACTIVE.has(status) ? false : 2_000;
    },
  });

export const useSchedules = () =>
  useQuery({
    queryKey: ["schedules"],
    queryFn: () => api<Schedule[]>("/v1/schedules"),
    refetchInterval: 15_000,
  });

export const useSchedulePreview = (cron: string, timezone: string) =>
  useQuery({
    queryKey: ["schedule-preview", cron, timezone],
    queryFn: () =>
      api<{ next: string[] }>("/v1/schedules/preview", { params: { cron, timezone, count: 5 } }),
    enabled: cron.trim().split(/\s+/).length >= 5,
    retry: false,
  });

/** Actions on a run; each refreshes the run and the lists that show it. */
export function useRunActions(id: string) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["run", id] }),
      queryClient.invalidateQueries({ queryKey: ["runs"] }),
      queryClient.invalidateQueries({ queryKey: ["stats"] }),
    ]);
  };
  return {
    cancel: useMutation({
      mutationFn: () => api<Run>(`/v1/runs/${id}/cancel`, { method: "POST" }),
      onSuccess: refresh,
    }),
    retry: useMutation({
      mutationFn: () => api<Run>(`/v1/runs/${id}/retry`, { method: "POST" }),
      onSuccess: refresh,
    }),
    signal: useMutation({
      mutationFn: (p: { name: string; payload: unknown }) =>
        api<unknown>(`/v1/runs/${id}/signals/${encodeURIComponent(p.name)}`, {
          method: "POST",
          body: { payload: p.payload },
        }),
      onSuccess: refresh,
    }),
  };
}

export function useScheduleActions() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["schedules"] });
  return {
    save: useMutation({
      mutationFn: (schedule: {
        id: string;
        workflow: string;
        cron: string;
        timezone: string;
        enabled?: boolean;
      }) => api<Schedule>("/v1/schedules", { method: "POST", body: schedule }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) =>
        api<void>(`/v1/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
  };
}
