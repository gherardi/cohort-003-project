import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  getInstructorAnalytics,
  resolveAnalyticsScope,
} from "./analyticsService";
import type { AnalyticsPeriod } from "~/lib/analyticsPeriods";

const NOW = new Date("2026-03-15T12:00:00.000Z");

function createUser(name: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

function createPurchase(courseId: number, pricePaid: number, createdAt: string) {
  return testDb
    .insert(schema.purchases)
    .values({ userId: base.user.id, courseId, pricePaid, country: null, createdAt })
    .returning()
    .get();
}

function createTeamPurchase(
  courseId: number,
  pricePaid: number,
  createdAt: string,
  seats: number
) {
  const purchase = createPurchase(courseId, pricePaid, createdAt);
  const team = testDb.insert(schema.teams).values({}).returning().get();
  for (let i = 0; i < seats; i++) {
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId,
        code: `code-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .run();
  }
  return purchase;
}

let studentCount = 0;

function createStudent() {
  studentCount += 1;
  return createUser(`Student ${studentCount}`, schema.UserRole.Student);
}

function createEnrollment(
  courseId: number,
  enrolledAt: string,
  student = createStudent()
) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId: student.id, courseId, enrolledAt })
    .returning()
    .get();
}

function createRating(courseId: number, rating: number, createdAt: string) {
  const student = createStudent();
  return testDb
    .insert(schema.courseRatings)
    .values({ userId: student.id, courseId, rating, createdAt, updatedAt: createdAt })
    .returning()
    .get();
}

function createCourse(
  title: string,
  instructorId: number,
  status = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title,
      slug: title.toLowerCase().replace(/ /g, "-"),
      description: title,
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

describe("analyticsService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  // ─── Scope Resolution ───

  describe("resolveAnalyticsScope", () => {
    it("gives an instructor their own id, ignoring a requested id", () => {
      const other = createUser("Other", schema.UserRole.Instructor);

      expect(resolveAnalyticsScope(base.instructor, other.id)).toEqual({
        kind: "instructor",
        instructorId: base.instructor.id,
      });
    });

    it("gives an admin the requested instructor", () => {
      const admin = createUser("Admin", schema.UserRole.Admin);

      expect(resolveAnalyticsScope(admin, base.instructor.id)).toEqual({
        kind: "instructor",
        instructorId: base.instructor.id,
      });
    });

    it("gives an admin with no selection 'none selected'", () => {
      const admin = createUser("Admin", schema.UserRole.Admin);

      expect(resolveAnalyticsScope(admin, null)).toEqual({
        kind: "none-selected",
      });
    });

    it("gives an admin who requests a non-instructor 'none selected'", () => {
      const admin = createUser("Admin", schema.UserRole.Admin);

      expect(resolveAnalyticsScope(admin, base.user.id)).toEqual({
        kind: "none-selected",
      });
      expect(resolveAnalyticsScope(admin, 9999)).toEqual({
        kind: "none-selected",
      });
    });

    it("forbids a student", () => {
      expect(resolveAnalyticsScope(base.user, base.instructor.id)).toEqual({
        kind: "forbidden",
      });
    });
  });

  // ─── Instructor Analytics ───

  describe("getInstructorAnalytics", () => {
    it("sums the amount actually paid on each Purchase as Revenue", () => {
      // List price is irrelevant: one full-price and one PPP-discounted Purchase
      createPurchase(base.course.id, 4999, "2026-03-10T09:00:00.000Z");
      createPurchase(base.course.id, 2500, "2026-03-11T09:00:00.000Z");

      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "30d",
        "day",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { revenue: 7499, purchases: 2, seats: 2 },
      });
    });

    it("counts a team Purchase as 1 Purchase and N Seats", () => {
      createTeamPurchase(base.course.id, 20000, "2026-03-10T09:00:00.000Z", 5);
      createPurchase(base.course.id, 4999, "2026-03-11T09:00:00.000Z");

      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "30d",
        "day",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { revenue: 24999, purchases: 2, seats: 6 },
      });
    });

    it("excludes Purchases of other instructors' courses", () => {
      const other = createUser("Other", schema.UserRole.Instructor);
      const otherCourse = createCourse("Other Course", other.id);
      createPurchase(base.course.id, 4999, "2026-03-10T09:00:00.000Z");
      createPurchase(otherCourse.id, 9999, "2026-03-10T09:00:00.000Z");

      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "30d",
        "day",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { revenue: 4999, purchases: 1, seats: 1 },
      });
    });

    it("covers the last 30 days in UTC, including today", () => {
      // NOW is 2026-03-15; the window is 2026-02-14 through 2026-03-15
      createPurchase(base.course.id, 1, "2026-02-13T23:59:59.999Z"); // just before
      createPurchase(base.course.id, 10, "2026-02-14T00:00:00.000Z"); // first day
      createPurchase(base.course.id, 100, "2026-03-15T00:00:00.000Z"); // today
      createPurchase(base.course.id, 1000, "2026-03-15T23:59:59.999Z"); // later today

      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "30d",
        "day",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { revenue: 1110, purchases: 3, seats: 3 },
      });
    });

    it("covers the last 7 days in UTC, including today", () => {
      // NOW is 2026-03-15; the window is 2026-03-09 through 2026-03-15
      createPurchase(base.course.id, 1, "2026-03-08T23:59:59.999Z"); // just before
      createPurchase(base.course.id, 10, "2026-03-09T00:00:00.000Z"); // first day
      createPurchase(base.course.id, 100, "2026-03-15T23:59:59.999Z"); // end of today

      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "7d",
        "day",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { revenue: 110, purchases: 2, seats: 2 },
      });
    });

    it("covers the last 12 months as whole calendar months, including today", () => {
      // NOW is 2026-03-15; the window is 2025-04-01 through 2026-03-15
      createPurchase(base.course.id, 1, "2025-03-31T23:59:59.999Z"); // just before
      createPurchase(base.course.id, 10, "2025-04-01T00:00:00.000Z"); // first day
      createPurchase(base.course.id, 100, "2026-03-15T23:59:59.999Z"); // end of today

      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "12m",
        "month",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { revenue: 110, purchases: 2, seats: 2 },
      });
    });

    it("rolls the 12-month window back across the year boundary", () => {
      // In January 2026 the window starts on 2025-02-01
      const january = new Date("2026-01-10T12:00:00.000Z");
      createPurchase(base.course.id, 1, "2025-01-31T23:59:59.999Z"); // just before
      createPurchase(base.course.id, 10, "2025-02-01T00:00:00.000Z"); // first day

      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "12m",
        "month",
        january
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { revenue: 10, purchases: 1, seats: 1 },
      });
    });

    it("covers all time from the first Purchase through today", () => {
      createPurchase(base.course.id, 10, "2019-06-01T08:00:00.000Z"); // first Purchase
      createPurchase(base.course.id, 100, "2026-03-15T23:59:59.999Z"); // end of today
      createPurchase(base.course.id, 1, "2026-03-16T00:00:00.000Z"); // just after

      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "all",
        "month",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { revenue: 110, purchases: 2, seats: 2 },
      });
    });

    it("returns zeros under all time for an instructor with no Purchases", () => {
      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "all",
        "month",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { revenue: 0, purchases: 0, seats: 0 },
      });
    });

    it("returns zeros for an instructor whose courses earned nothing", () => {
      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "30d",
        "day",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { revenue: 0, purchases: 0, seats: 0 },
      });
    });

    it("counts Enrollments created in the period, whether bought, redeemed or free", () => {
      // A team member redeems one of the team Purchase's coupons
      const purchase = createTeamPurchase(
        base.course.id,
        20000,
        "2026-03-01T09:00:00.000Z",
        5
      );
      const teamMember = createStudent();
      const redeemedAt = "2026-03-02T09:00:00.000Z";
      const coupon = testDb
        .select()
        .from(schema.coupons)
        .where(eq(schema.coupons.purchaseId, purchase.id))
        .get()!;
      testDb
        .update(schema.coupons)
        .set({ redeemedByUserId: teamMember.id, redeemedAt })
        .where(eq(schema.coupons.id, coupon.id))
        .run();
      createEnrollment(base.course.id, redeemedAt, teamMember);
      // A free signup with no Purchase behind it, later today
      const freeCourse = createCourse("Free Course", base.instructor.id);
      createEnrollment(freeCourse.id, "2026-03-15T23:59:59.999Z");
      createEnrollment(base.course.id, "2026-02-13T23:59:59.999Z"); // before the window

      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "30d",
        "day",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { enrollments: 2 },
      });
    });

    it("excludes Enrollments in other instructors' courses", () => {
      const other = createUser("Other", schema.UserRole.Instructor);
      const otherCourse = createCourse("Other Course", other.id);
      createEnrollment(otherCourse.id, "2026-03-10T09:00:00.000Z");

      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "30d",
        "day",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { enrollments: 0 },
      });
    });

    it("averages ratings across all the instructor's courses for all time, whatever the period", () => {
      const second = createCourse("Second Course", base.instructor.id);
      const other = createUser("Other", schema.UserRole.Instructor);
      const otherCourse = createCourse("Other Course", other.id);
      createRating(base.course.id, 5, "2024-01-01T09:00:00.000Z"); // years ago
      createRating(base.course.id, 4, "2026-03-14T09:00:00.000Z");
      createRating(second.id, 3, "2025-06-01T09:00:00.000Z");
      createRating(otherCourse.id, 1, "2026-03-14T09:00:00.000Z");

      for (const period of ["7d", "30d", "12m", "all"] as const) {
        const analytics = getInstructorAnalytics(
          base.instructor.id,
          period,
          "day",
          NOW
        );

        expect(analytics).toMatchObject({
          hasCourses: true,
          summary: { rating: { average: 4, count: 3 } },
        });
      }
    });

    it("gives an instructor with no ratings an empty rating, not zero", () => {
      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "30d",
        "day",
        NOW
      );

      expect(analytics).toMatchObject({
        hasCourses: true,
        summary: { rating: { average: null, count: 0 } },
      });
    });

    it("tells an instructor with no courses that they have none", () => {
      const newcomer = createUser("Newcomer", schema.UserRole.Instructor);

      const analytics = getInstructorAnalytics(newcomer.id, "30d", "day", NOW);

      expect(analytics).toEqual({ hasCourses: false });
    });
  });

  // ─── Per-Course Rows ───

  describe("getInstructorAnalytics courses", () => {
    function getCourseRows(period: AnalyticsPeriod = "30d") {
      const analytics = getInstructorAnalytics(
        base.instructor.id,
        period,
        "day",
        NOW
      );
      if (!analytics.hasCourses) throw new Error("expected courses");
      return analytics.courses;
    }

    it("includes every owned course, in any status, as zero rows when nothing sold", () => {
      const draft = createCourse(
        "Draft Course",
        base.instructor.id,
        schema.CourseStatus.Draft
      );
      const archived = createCourse(
        "Archived Course",
        base.instructor.id,
        schema.CourseStatus.Archived
      );

      const rows = getCourseRows();

      // All tied at zero Revenue, so they fall back to title order
      expect(rows).toEqual([
        {
          id: archived.id,
          title: "Archived Course",
          status: schema.CourseStatus.Archived,
          revenue: 0,
          purchases: 0,
          seats: 0,
          enrollments: 0,
          rating: { average: null, count: 0 },
        },
        {
          id: draft.id,
          title: "Draft Course",
          status: schema.CourseStatus.Draft,
          revenue: 0,
          purchases: 0,
          seats: 0,
          enrollments: 0,
          rating: { average: null, count: 0 },
        },
        {
          id: base.course.id,
          title: "Test Course",
          status: schema.CourseStatus.Published,
          revenue: 0,
          purchases: 0,
          seats: 0,
          enrollments: 0,
          rating: { average: null, count: 0 },
        },
      ]);
    });

    it("orders rows by Revenue in the period, highest first", () => {
      const middle = createCourse("Middle Course", base.instructor.id);
      const top = createCourse("Top Course", base.instructor.id);
      createPurchase(middle.id, 3000, "2026-03-10T09:00:00.000Z");
      createPurchase(top.id, 4000, "2026-03-10T09:00:00.000Z");
      createPurchase(top.id, 4000, "2026-03-11T09:00:00.000Z");
      // Outside the 30-day window, so it doesn't lift Test Course to the top
      createPurchase(base.course.id, 99999, "2026-01-01T09:00:00.000Z");

      const rows = getCourseRows();

      expect(rows.map((row) => [row.title, row.revenue])).toEqual([
        ["Top Course", 8000],
        ["Middle Course", 3000],
        ["Test Course", 0],
      ]);
    });

    it("never includes courses of other instructors", () => {
      const other = createUser("Other", schema.UserRole.Instructor);
      const otherCourse = createCourse("Other Course", other.id);
      createPurchase(otherCourse.id, 9999, "2026-03-10T09:00:00.000Z");

      const rows = getCourseRows();

      expect(rows.map((row) => row.id)).toEqual([base.course.id]);
    });

    it("counts each course's Enrollments in the period and its all-time rating", () => {
      const second = createCourse("Second Course", base.instructor.id);
      createEnrollment(base.course.id, "2026-03-10T09:00:00.000Z");
      createEnrollment(base.course.id, "2026-03-11T09:00:00.000Z");
      createEnrollment(base.course.id, "2026-01-01T09:00:00.000Z"); // before the 7 days
      createEnrollment(second.id, "2026-03-12T09:00:00.000Z");
      createRating(base.course.id, 5, "2024-01-01T09:00:00.000Z"); // before the 7 days
      createRating(base.course.id, 2, "2026-03-14T09:00:00.000Z");

      const rows = getCourseRows("7d");

      expect(
        rows.map((row) => [row.title, row.enrollments, row.rating])
      ).toEqual([
        ["Second Course", 1, { average: null, count: 0 }],
        ["Test Course", 2, { average: 3.5, count: 2 }],
      ]);
    });

    it("counts a team Purchase as 1 Purchase and N Seats on its course", () => {
      createTeamPurchase(base.course.id, 20000, "2026-03-10T09:00:00.000Z", 5);
      createPurchase(base.course.id, 4999, "2026-03-11T09:00:00.000Z");

      const rows = getCourseRows();

      expect(rows).toEqual([
        {
          id: base.course.id,
          title: "Test Course",
          status: schema.CourseStatus.Published,
          revenue: 24999,
          purchases: 2,
          seats: 6,
          enrollments: 0,
          rating: { average: null, count: 0 },
        },
      ]);
    });
  });

  // ─── Revenue Series ───

  describe("getInstructorAnalytics series", () => {
    function getSeries(
      period: AnalyticsPeriod,
      granularity: string | null,
      now = NOW
    ) {
      const analytics = getInstructorAnalytics(
        base.instructor.id,
        period,
        granularity,
        now
      );
      if (!analytics.hasCourses) throw new Error("expected courses");
      return analytics.series;
    }

    it("has a point for every day of the period, zero where nothing sold", () => {
      createPurchase(base.course.id, 4999, "2026-03-10T09:00:00.000Z");
      createTeamPurchase(base.course.id, 20000, "2026-03-10T23:59:59.999Z", 5);
      createPurchase(base.course.id, 2500, "2026-03-15T23:59:59.999Z"); // later today
      createPurchase(base.course.id, 1, "2026-03-08T23:59:59.999Z"); // before the 7 days

      expect(getSeries("7d", "day")).toEqual([
        { bucketStart: "2026-03-09", label: "Mar 9", revenue: 0, purchases: 0 },
        { bucketStart: "2026-03-10", label: "Mar 10", revenue: 24999, purchases: 2 },
        { bucketStart: "2026-03-11", label: "Mar 11", revenue: 0, purchases: 0 },
        { bucketStart: "2026-03-12", label: "Mar 12", revenue: 0, purchases: 0 },
        { bucketStart: "2026-03-13", label: "Mar 13", revenue: 0, purchases: 0 },
        { bucketStart: "2026-03-14", label: "Mar 14", revenue: 0, purchases: 0 },
        { bucketStart: "2026-03-15", label: "Mar 15", revenue: 2500, purchases: 1 },
      ]);
    });

    it("buckets weeks Monday to Sunday in UTC, labelled by their Monday", () => {
      // NOW is Sunday 2026-03-15; the 30 days start on Saturday 2026-02-14,
      // inside the week of Monday 2026-02-09
      createPurchase(base.course.id, 10, "2026-02-14T00:00:00.000Z"); // first day
      createPurchase(base.course.id, 100, "2026-03-08T23:59:59.999Z"); // Sunday
      createPurchase(base.course.id, 1000, "2026-03-09T00:00:00.000Z"); // Monday
      createPurchase(base.course.id, 1000, "2026-03-15T23:59:59.999Z"); // end of today

      expect(getSeries("30d", "week")).toEqual([
        { bucketStart: "2026-02-09", label: "Week of Feb 9", revenue: 10, purchases: 1 },
        { bucketStart: "2026-02-16", label: "Week of Feb 16", revenue: 0, purchases: 0 },
        { bucketStart: "2026-02-23", label: "Week of Feb 23", revenue: 0, purchases: 0 },
        { bucketStart: "2026-03-02", label: "Week of Mar 2", revenue: 100, purchases: 1 },
        { bucketStart: "2026-03-09", label: "Week of Mar 9", revenue: 2000, purchases: 2 },
      ]);
    });

    it("has a point for each of the last 12 calendar months", () => {
      createPurchase(base.course.id, 10, "2025-04-01T00:00:00.000Z"); // first day
      createPurchase(base.course.id, 100, "2025-12-31T23:59:59.999Z");
      createPurchase(base.course.id, 1000, "2026-03-15T23:59:59.999Z"); // end of today

      const series = getSeries("12m", "month");

      expect(series.map((point) => [point.label, point.revenue])).toEqual([
        ["Apr 2025", 10],
        ["May 2025", 0],
        ["Jun 2025", 0],
        ["Jul 2025", 0],
        ["Aug 2025", 0],
        ["Sep 2025", 0],
        ["Oct 2025", 0],
        ["Nov 2025", 0],
        ["Dec 2025", 100],
        ["Jan 2026", 0],
        ["Feb 2026", 0],
        ["Mar 2026", 1000],
      ]);
      expect(series[0].bucketStart).toBe("2025-04-01");
    });

    it("starts all time at the month of the first Purchase", () => {
      createPurchase(base.course.id, 10, "2025-12-20T08:00:00.000Z"); // first Purchase
      createPurchase(base.course.id, 100, "2026-03-01T00:00:00.000Z");

      expect(getSeries("all", "month")).toEqual([
        { bucketStart: "2025-12-01", label: "Dec 2025", revenue: 10, purchases: 1 },
        { bucketStart: "2026-01-01", label: "Jan 2026", revenue: 0, purchases: 0 },
        { bucketStart: "2026-02-01", label: "Feb 2026", revenue: 0, purchases: 0 },
        { bucketStart: "2026-03-01", label: "Mar 2026", revenue: 100, purchases: 1 },
      ]);
    });

    it("starts all time at the Monday of the first Purchase's week", () => {
      createPurchase(base.course.id, 10, "2026-03-04T08:00:00.000Z"); // a Wednesday

      expect(getSeries("all", "week")).toEqual([
        { bucketStart: "2026-03-02", label: "Week of Mar 2", revenue: 10, purchases: 1 },
        { bucketStart: "2026-03-09", label: "Week of Mar 9", revenue: 0, purchases: 0 },
      ]);
    });

    it("gives an instructor with no Revenue a zero point for every day", () => {
      const series = getSeries("30d", "day");

      expect(series).toHaveLength(30);
      expect(series[0].bucketStart).toBe("2026-02-14");
      expect(series[29].bucketStart).toBe("2026-03-15");
      expect(series.every((point) => point.revenue === 0 && point.purchases === 0)).toBe(true);
    });

    it("gives an empty series under all time when there are no Purchases", () => {
      expect(getSeries("all", "month")).toEqual([]);
    });

    it("buckets a disallowed granularity by the period's default", () => {
      // Day isn't allowed for 12 months, so it's bucketed by month
      expect(getSeries("12m", "day")[0].label).toBe("Apr 2025");
      // Month isn't allowed for 7 days, so it's bucketed by day
      expect(getSeries("7d", "month")[0].label).toBe("Mar 9");
    });
  });

  // ─── Granularity ───

  describe("getInstructorAnalytics granularity", () => {
    function getGranularity(period: AnalyticsPeriod, granularity: string | null) {
      const analytics = getInstructorAnalytics(
        base.instructor.id,
        period,
        granularity,
        NOW
      );
      if (!analytics.hasCourses) throw new Error("expected courses");
      return analytics.granularity;
    }

    it("defaults to day for 7 and 30 days, and month for 12 months and all time", () => {
      expect(getGranularity("7d", null)).toBe("day");
      expect(getGranularity("30d", null)).toBe("day");
      expect(getGranularity("12m", null)).toBe("month");
      expect(getGranularity("all", null)).toBe("month");
    });

    it("keeps an allowed granularity", () => {
      expect(getGranularity("7d", "week")).toBe("week");
      expect(getGranularity("30d", "month")).toBe("month");
      expect(getGranularity("12m", "week")).toBe("week");
      expect(getGranularity("all", "week")).toBe("week");
    });

    it("falls back to the period's default for a disallowed or invalid value", () => {
      expect(getGranularity("12m", "day")).toBe("month");
      expect(getGranularity("all", "day")).toBe("month");
      expect(getGranularity("7d", "month")).toBe("day");
      expect(getGranularity("30d", "hourly")).toBe("day");
    });
  });
});
