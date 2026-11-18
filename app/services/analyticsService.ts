import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  CourseStatus,
  enrollments,
  purchases,
  UserRole,
} from "~/db/schema";
import { getCoursesByInstructor } from "~/services/courseService";
import {
  getRatingSummariesForCourses,
  type RatingSummary,
} from "~/services/ratingService";
import { getUserById } from "~/services/userService";
import {
  getPeriodOption,
  parseAnalyticsGranularity,
  type AnalyticsGranularity,
  type AnalyticsPeriod,
} from "~/lib/analyticsPeriods";

// ─── Analytics Service ───
// Powers the Instructor Analytics Dashboard: whose data a viewer may see,
// and the Revenue, Enrollment and rating figures for one instructor's courses.
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

export type AnalyticsSummary = {
  revenue: number;
  purchases: number;
  seats: number;
  enrollments: number;
  // All-time, unlike the other figures, which follow the period
  rating: RatingSummary;
};

export type AnalyticsCourseRow = {
  id: number;
  title: string;
  status: CourseStatus;
  revenue: number;
  purchases: number;
  seats: number;
  enrollments: number;
  rating: RatingSummary;
};

// One point on the Revenue chart
export type AnalyticsSeriesPoint = {
  // UTC date the bucket starts on, as YYYY-MM-DD
  bucketStart: string;
  label: string;
  revenue: number;
  purchases: number;
};

export type InstructorAnalytics =
  | { hasCourses: false }
  | {
      hasCourses: true;
      // The granularity actually used, after any fallback
      granularity: AnalyticsGranularity;
      summary: AnalyticsSummary;
      series: AnalyticsSeriesPoint[];
      courses: AnalyticsCourseRow[];
    };

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

// The average of every rating, so a course's weight follows its rating count
function combineRatingSummaries(summaries: RatingSummary[]): RatingSummary {
  let count = 0;
  let total = 0;
  for (const summary of summaries) {
    count += summary.count;
    total += (summary.average ?? 0) * summary.count;
  }
  return { average: count === 0 ? null : total / count, count };
}

function getBucketStart(date: Date, granularity: AnalyticsGranularity) {
  const day = startOfUtcDay(date);
  if (granularity === "week") {
    // Weeks start on Monday; getUTCDay() counts from Sunday
    const daysSinceMonday = (day.getUTCDay() + 6) % 7;
    return new Date(day.getTime() - daysSinceMonday * DAY_MS);
  }
  if (granularity === "month") {
    return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
  }
  return day;
}

function getNextBucketStart(
  bucketStart: Date,
  granularity: AnalyticsGranularity
) {
  if (granularity === "month") {
    return new Date(
      Date.UTC(bucketStart.getUTCFullYear(), bucketStart.getUTCMonth() + 1, 1)
    );
  }
  const days = granularity === "week" ? 7 : 1;
  return new Date(bucketStart.getTime() + days * DAY_MS);
}

function formatBucketLabel(
  bucketStart: Date,
  granularity: AnalyticsGranularity
) {
  if (granularity === "month") {
    return bucketStart.toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "short",
      year: "numeric",
    });
  }
  const day = bucketStart.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  });
  return granularity === "week" ? `Week of ${day}` : day;
}

// One zero-filled point per bucket from the period start through today
function buildSeries(
  rows: { createdAt: string; pricePaid: number }[],
  start: Date,
  end: Date,
  granularity: AnalyticsGranularity
): AnalyticsSeriesPoint[] {
  const points = new Map<string, AnalyticsSeriesPoint>();
  for (
    let bucketStart = getBucketStart(start, granularity);
    bucketStart < end;
    bucketStart = getNextBucketStart(bucketStart, granularity)
  ) {
    const key = bucketStart.toISOString().slice(0, 10);
    points.set(key, {
      bucketStart: key,
      label: formatBucketLabel(bucketStart, granularity),
      revenue: 0,
      purchases: 0,
    });
  }

  for (const row of rows) {
    const key = getBucketStart(new Date(row.createdAt), granularity)
      .toISOString()
      .slice(0, 10);
    // Rows are already filtered to the period, so their bucket always exists
    const point = points.get(key)!;
    point.revenue += row.pricePaid;
    point.purchases += 1;
  }

  return [...points.values()];
}

export function getInstructorAnalytics(
  instructorId: number,
  period: AnalyticsPeriod,
  // Straight from the URL; validated here so the chart and tabs always agree
  requestedGranularity: string | null,
  now: Date
): InstructorAnalytics {
  const granularity = parseAnalyticsGranularity(period, requestedGranularity);
  const instructorCourses = getCoursesByInstructor(instructorId);
  if (instructorCourses.length === 0) {
    return { hasCourses: false };
  }

  const { start, end } = getPeriodRange(period, now);

  const purchaseRows = db
    .select({
      courseId: purchases.courseId,
      pricePaid: purchases.pricePaid,
      createdAt: purchases.createdAt,
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

  const enrollmentRows = db
    .select({ courseId: enrollments.courseId })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(
      and(
        eq(courses.instructorId, instructorId),
        start ? gte(enrollments.enrolledAt, start.toISOString()) : undefined,
        lt(enrollments.enrolledAt, end.toISOString())
      )
    )
    .all();

  const courseRatingSummaries = getRatingSummariesForCourses(
    instructorCourses.map((course) => course.id)
  );

  // Every owned course gets a row, so courses that sold nothing show as zeros
  const courseRows = new Map<number, AnalyticsCourseRow>(
    instructorCourses.map((course) => [
      course.id,
      {
        id: course.id,
        title: course.title,
        status: course.status,
        revenue: 0,
        purchases: 0,
        seats: 0,
        enrollments: 0,
        rating: courseRatingSummaries.get(course.id)!,
      },
    ])
  );

  const summary: AnalyticsSummary = {
    revenue: 0,
    purchases: 0,
    seats: 0,
    enrollments: enrollmentRows.length,
    rating: combineRatingSummaries([...courseRatingSummaries.values()]),
  };
  for (const row of purchaseRows) {
    // A team Purchase has one Seat per generated coupon; an individual one has one
    const seats = row.couponCount > 0 ? row.couponCount : 1;
    summary.revenue += row.pricePaid;
    summary.purchases += 1;
    summary.seats += seats;

    // Both queries filter on the same instructor, so the row always exists
    const courseRow = courseRows.get(row.courseId)!;
    courseRow.revenue += row.pricePaid;
    courseRow.purchases += 1;
    courseRow.seats += seats;
  }

  for (const row of enrollmentRows) {
    courseRows.get(row.courseId)!.enrollments += 1;
  }

  // Highest Revenue first (ties by title); the table can't be re-sorted
  const sortedCourseRows = [...courseRows.values()].sort(
    (a, b) => b.revenue - a.revenue || a.title.localeCompare(b.title)
  );

  // "all" starts at the bucket holding the instructor's first Purchase
  const firstPurchaseAt = purchaseRows.reduce<string | null>(
    (first, row) => (first === null || row.createdAt < first ? row.createdAt : first),
    null
  );
  const seriesStart =
    start ?? (firstPurchaseAt === null ? null : new Date(firstPurchaseAt));
  const series = seriesStart
    ? buildSeries(purchaseRows, seriesStart, end, granularity)
    : [];

  return {
    hasCourses: true,
    granularity,
    summary,
    series,
    courses: sortedCourseRows,
  };
}
