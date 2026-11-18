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
  type AnalyticsPeriod,
} from "./analyticsService";

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
});
