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
  toggleBookmark,
  isLessonBookmarked,
  getBookmarkedLessonIds,
} from "./bookmarkService";

function createLesson(courseId: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();

  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "Lesson", position: 1 })
    .returning()
    .get();
}

function createCourse(slug: string) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: "Another course",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

describe("bookmarkService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("toggleBookmark", () => {
    it("bookmarks an unbookmarked lesson", () => {
      const lesson = createLesson(base.course.id);

      expect(toggleBookmark(base.user.id, lesson.id)).toEqual({
        bookmarked: true,
      });
      expect(isLessonBookmarked(base.user.id, lesson.id)).toBe(true);
    });

    it("removes an existing bookmark", () => {
      const lesson = createLesson(base.course.id);

      toggleBookmark(base.user.id, lesson.id);

      expect(toggleBookmark(base.user.id, lesson.id)).toEqual({
        bookmarked: false,
      });
      expect(isLessonBookmarked(base.user.id, lesson.id)).toBe(false);
    });

    it("keeps bookmarks private to each user", () => {
      const lesson = createLesson(base.course.id);

      toggleBookmark(base.user.id, lesson.id);

      expect(isLessonBookmarked(base.instructor.id, lesson.id)).toBe(false);
    });
  });

  describe("getBookmarkedLessonIds", () => {
    it("returns only bookmarked lessons in the given course", () => {
      const otherCourse = createCourse("other-course");
      const lessonA = createLesson(base.course.id);
      const lessonB = createLesson(base.course.id);
      const otherLesson = createLesson(otherCourse.id);

      toggleBookmark(base.user.id, lessonA.id);
      toggleBookmark(base.user.id, otherLesson.id);

      const ids = getBookmarkedLessonIds(base.user.id, base.course.id);

      expect(ids).toEqual([lessonA.id]);
      expect(ids).not.toContain(lessonB.id);
    });

    it("returns an empty array when nothing is bookmarked", () => {
      createLesson(base.course.id);

      expect(getBookmarkedLessonIds(base.user.id, base.course.id)).toEqual([]);
    });
  });
});
