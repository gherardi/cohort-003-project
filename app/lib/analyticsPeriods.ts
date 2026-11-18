// ─── Analytics Periods ───
// Period and granularity options for the Instructor Analytics Dashboard.
// Kept free of database imports so the route component can use them in the browser.

export type AnalyticsPeriod = "7d" | "30d" | "12m" | "all";
export type AnalyticsGranularity = "day" | "week" | "month";

export const ANALYTICS_PERIODS: {
  value: AnalyticsPeriod;
  label: string;
  defaultGranularity: AnalyticsGranularity;
  // Day would give hundreds of points; month would give a single one
  allowedGranularities: AnalyticsGranularity[];
}[] = [
  {
    value: "7d",
    label: "Last 7 days",
    defaultGranularity: "day",
    allowedGranularities: ["day", "week"],
  },
  {
    value: "30d",
    label: "Last 30 days",
    defaultGranularity: "day",
    allowedGranularities: ["day", "week", "month"],
  },
  {
    value: "12m",
    label: "Last 12 months",
    defaultGranularity: "month",
    allowedGranularities: ["week", "month"],
  },
  {
    value: "all",
    label: "All time",
    defaultGranularity: "month",
    allowedGranularities: ["week", "month"],
  },
];

export const ANALYTICS_GRANULARITIES: {
  value: AnalyticsGranularity;
  label: string;
}[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

export const DEFAULT_ANALYTICS_PERIOD: AnalyticsPeriod = "30d";

// A missing or unknown period falls back to the default
export function parseAnalyticsPeriod(value: string | null): AnalyticsPeriod {
  return (
    ANALYTICS_PERIODS.find((option) => option.value === value)?.value ??
    DEFAULT_ANALYTICS_PERIOD
  );
}

export function isGranularityAllowed(
  period: AnalyticsPeriod,
  granularity: AnalyticsGranularity
) {
  return getPeriodOption(period).allowedGranularities.includes(granularity);
}

// A missing, unknown or disallowed granularity falls back to the period's default
export function parseAnalyticsGranularity(
  period: AnalyticsPeriod,
  value: string | null
): AnalyticsGranularity {
  const granularity = ANALYTICS_GRANULARITIES.find(
    (option) => option.value === value
  )?.value;
  return granularity && isGranularityAllowed(period, granularity)
    ? granularity
    : getPeriodOption(period).defaultGranularity;
}

export function getPeriodOption(period: AnalyticsPeriod) {
  return ANALYTICS_PERIODS.find((option) => option.value === period)!;
}
