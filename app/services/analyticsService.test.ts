import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

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

function createCourse(title: string, instructorId: number) {
  return testDb
    .insert(schema.courses)
    .values({
      title,
      slug: title.toLowerCase().replace(/ /g, "-"),
      description: title,
      instructorId,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
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

      expect(analytics).toEqual({
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

      expect(analytics).toEqual({
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

      expect(analytics).toEqual({
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

      expect(analytics).toEqual({
        hasCourses: true,
        summary: { revenue: 1110, purchases: 3, seats: 3 },
      });
    });

    it("returns zeros for an instructor whose courses earned nothing", () => {
      const analytics = getInstructorAnalytics(
        base.instructor.id,
        "30d",
        "day",
        NOW
      );

      expect(analytics).toEqual({
        hasCourses: true,
        summary: { revenue: 0, purchases: 0, seats: 0 },
      });
    });

    it("tells an instructor with no courses that they have none", () => {
      const newcomer = createUser("Newcomer", schema.UserRole.Instructor);

      const analytics = getInstructorAnalytics(newcomer.id, "30d", "day", NOW);

      expect(analytics).toEqual({ hasCourses: false });
    });
  });
});
