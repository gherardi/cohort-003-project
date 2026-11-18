import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "~/db";
import { coupons, courses, purchases, UserRole } from "~/db/schema";
import { getCoursesByInstructor } from "~/services/courseService";
import { getUserById } from "~/services/userService";

// ─── Analytics Service ───
// Powers the Instructor Analytics Dashboard: whose data a viewer may see,
// and the Revenue figures for one instructor's courses.
// Uses positional parameters (project convention).

export type AnalyticsViewer = {
  id: number;
  role: UserRole;
};

export type AnalyticsScope =
  | { kind: "instructor"; instructorId: number }
  | { kind: "none-selected" }
  | { kind: "forbidden" };

export function resolveAnalyticsScope(
  viewer: AnalyticsViewer,
  requestedInstructorId: number | null
): AnalyticsScope {
  if (viewer.role === UserRole.Instructor) {
    return { kind: "instructor", instructorId: viewer.id };
  }

  if (viewer.role === UserRole.Admin) {
    const requestedUser =
      requestedInstructorId === null ? null : getUserById(requestedInstructorId);
    if (requestedUser?.role !== UserRole.Instructor) {
      return { kind: "none-selected" };
    }
    return { kind: "instructor", instructorId: requestedUser.id };
  }

  return { kind: "forbidden" };
}

// ─── Instructor Analytics ───

export type AnalyticsPeriod = "7d" | "30d" | "12m" | "all";
export type AnalyticsGranularity = "day" | "month";

export const ANALYTICS_PERIODS: {
  value: AnalyticsPeriod;
  label: string;
  defaultGranularity: AnalyticsGranularity;
}[] = [
  { value: "7d", label: "Last 7 days", defaultGranularity: "day" },
  { value: "30d", label: "Last 30 days", defaultGranularity: "day" },
  { value: "12m", label: "Last 12 months", defaultGranularity: "month" },
  { value: "all", label: "All time", defaultGranularity: "month" },
];

export const DEFAULT_ANALYTICS_PERIOD: AnalyticsPeriod = "30d";

// A missing or unknown period falls back to the default
export function parseAnalyticsPeriod(value: string | null): AnalyticsPeriod {
  return (
    ANALYTICS_PERIODS.find((option) => option.value === value)?.value ??
    DEFAULT_ANALYTICS_PERIOD
  );
}

export type AnalyticsSummary = {
  revenue: number;
  purchases: number;
  seats: number;
};

export type InstructorAnalytics =
  | { hasCourses: false }
  | { hasCourses: true; summary: AnalyticsSummary };

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

// Every period runs from its first UTC day through the end of today (UTC).
// "all" has no start: it begins at the instructor's first Purchase.
function getPeriodRange(
  period: AnalyticsPeriod,
  now: Date
): { start: Date | null; end: Date } {
  const end = new Date(startOfUtcDay(now).getTime() + DAY_MS);
  if (period === "all") {
    return { start: null, end };
  }
  if (period === "12m") {
    // The current calendar month plus the 11 before it
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)
    );
    return { start, end };
  }
  const days = period === "7d" ? 7 : 30;
  const start = new Date(end.getTime() - days * DAY_MS);
  return { start, end };
}

export function getInstructorAnalytics(
  instructorId: number,
  period: AnalyticsPeriod,
  granularity: AnalyticsGranularity,
  now: Date
): InstructorAnalytics {
  if (getCoursesByInstructor(instructorId).length === 0) {
    return { hasCourses: false };
  }

  const { start, end } = getPeriodRange(period, now);

  const rows = db
    .select({
      pricePaid: purchases.pricePaid,
      couponCount: sql<number>`(select count(*) from ${coupons} where ${coupons.purchaseId} = ${purchases.id})`,
    })
    .from(purchases)
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        eq(courses.instructorId, instructorId),
        start ? gte(purchases.createdAt, start.toISOString()) : undefined,
        lt(purchases.createdAt, end.toISOString())
      )
    )
    .all();

  const summary: AnalyticsSummary = { revenue: 0, purchases: 0, seats: 0 };
  for (const row of rows) {
    summary.revenue += row.pricePaid;
    summary.purchases += 1;
    // A team Purchase has one Seat per generated coupon; an individual one has one
    summary.seats += row.couponCount > 0 ? row.couponCount : 1;
  }

  return { hasCourses: true, summary };
}
