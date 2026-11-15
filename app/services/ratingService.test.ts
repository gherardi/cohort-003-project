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

// Import after mock so the module picks up our test db
import {
  rateCourse,
  getUserRating,
  getCourseRatingSummary,
  getRatingSummariesForCourses,
  removeCourseRating,
} from "./ratingService";

function enroll(userId: number, courseId: number) {
  testDb.insert(schema.enrollments).values({ userId, courseId }).run();
}

function createStudent(email: string) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role: schema.UserRole.Student })
    .returning()
    .get();
}

describe("ratingService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("rateCourse", () => {
    it("creates a rating for an enrolled student", () => {
      enroll(base.user.id, base.course.id);

      const rating = rateCourse(base.user.id, base.course.id, 4);

      expect(rating.rating).toBe(4);
      expect(getUserRating(base.user.id, base.course.id)).toBe(4);
    });

    it("updates an existing rating instead of creating a second one", () => {
      enroll(base.user.id, base.course.id);

      rateCourse(base.user.id, base.course.id, 4);
      rateCourse(base.user.id, base.course.id, 2);

      expect(getUserRating(base.user.id, base.course.id)).toBe(2);
      expect(getCourseRatingSummary(base.course.id).count).toBe(1);
    });

    it("throws when the user is not enrolled", () => {
      expect(() => rateCourse(base.user.id, base.course.id, 5)).toThrowError(
        "Only enrolled students can rate this course"
      );
    });

    it.each([0, 6, 2.5, NaN])("rejects invalid rating %s", (value) => {
      enroll(base.user.id, base.course.id);

      expect(() => rateCourse(base.user.id, base.course.id, value)).toThrowError(
        "Rating must be a whole number between 1 and 5"
      );
    });
  });

  describe("removeCourseRating", () => {
    it("removes the user's rating and updates the summary", () => {
      const other = createStudent("other@example.com");
      enroll(base.user.id, base.course.id);
      enroll(other.id, base.course.id);
      rateCourse(base.user.id, base.course.id, 5);
      rateCourse(other.id, base.course.id, 3);

      removeCourseRating(base.user.id, base.course.id);

      expect(getUserRating(base.user.id, base.course.id)).toBeNull();
      expect(getCourseRatingSummary(base.course.id)).toEqual({
        average: 3,
        count: 1,
      });
    });

    it("is a no-op when the user has no rating", () => {
      expect(removeCourseRating(base.user.id, base.course.id)).toBeUndefined();
    });
  });

  describe("getUserRating", () => {
    it("returns null when the user has not rated the course", () => {
      expect(getUserRating(base.user.id, base.course.id)).toBeNull();
    });
  });

  describe("getCourseRatingSummary", () => {
    it("returns null average and zero count when there are no ratings", () => {
      expect(getCourseRatingSummary(base.course.id)).toEqual({
        average: null,
        count: 0,
      });
    });

    it("averages all ratings for the course", () => {
      const other = createStudent("other@example.com");
      enroll(base.user.id, base.course.id);
      enroll(other.id, base.course.id);

      rateCourse(base.user.id, base.course.id, 5);
      rateCourse(other.id, base.course.id, 2);

      expect(getCourseRatingSummary(base.course.id)).toEqual({
        average: 3.5,
        count: 2,
      });
    });
  });

  describe("getRatingSummariesForCourses", () => {
    it("returns a summary for every requested course", () => {
      const secondCourse = testDb
        .insert(schema.courses)
        .values({
          title: "Second Course",
          slug: "second-course",
          description: "Another course",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Published,
        })
        .returning()
        .get();

      enroll(base.user.id, base.course.id);
      rateCourse(base.user.id, base.course.id, 3);

      const summaries = getRatingSummariesForCourses([
        base.course.id,
        secondCourse.id,
      ]);

      expect(summaries.get(base.course.id)).toEqual({ average: 3, count: 1 });
      expect(summaries.get(secondCourse.id)).toEqual({
        average: null,
        count: 0,
      });
    });

    it("returns an empty map for no course ids", () => {
      expect(getRatingSummariesForCourses([]).size).toBe(0);
    });
  });
});
