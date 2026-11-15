import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let lessonId: number;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the module picks up our test db
import {
  createComment,
  deleteComment,
  getCommentsForLesson,
  canAccessLessonComments,
  canModerateCourseComments,
  MAX_COMMENT_LENGTH,
} from "./commentService";

function enroll(userId: number, courseId: number) {
  testDb.insert(schema.enrollments).values({ userId, courseId }).run();
}

function createUser(email: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({ name: email, email, role })
    .returning()
    .get();
}

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

function getRawComment(id: number) {
  return testDb
    .select()
    .from(schema.lessonComments)
    .where(eq(schema.lessonComments.id, id))
    .get();
}

describe("commentService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    lessonId = createLesson(base.course.id).id;
  });

  describe("access", () => {
    it("grants access to enrolled students, the instructor and admins", () => {
      const admin = createUser("admin@example.com", schema.UserRole.Admin);
      enroll(base.user.id, base.course.id);

      expect(canAccessLessonComments(base.user.id, base.course.id)).toBe(true);
      expect(
        canAccessLessonComments(base.instructor.id, base.course.id)
      ).toBe(true);
      expect(canAccessLessonComments(admin.id, base.course.id)).toBe(true);
    });

    it("denies access to students who are not enrolled", () => {
      expect(canAccessLessonComments(base.user.id, base.course.id)).toBe(
        false
      );
    });

    it("only lets the course instructor and admins moderate", () => {
      const otherInstructor = createUser(
        "other@example.com",
        schema.UserRole.Instructor
      );
      enroll(base.user.id, base.course.id);

      expect(
        canModerateCourseComments(base.instructor.id, base.course.id)
      ).toBe(true);
      expect(canModerateCourseComments(base.user.id, base.course.id)).toBe(
        false
      );
      expect(
        canModerateCourseComments(otherInstructor.id, base.course.id)
      ).toBe(false);
    });
  });

  describe("createComment", () => {
    it("creates a comment for an enrolled student", () => {
      enroll(base.user.id, base.course.id);

      const comment = createComment(base.user.id, lessonId, "  Great lesson!  ");

      expect(comment.content).toBe("Great lesson!");
      expect(getCommentsForLesson(lessonId)).toHaveLength(1);
    });

    it("lets the instructor and admins comment without enrolling", () => {
      const admin = createUser("admin@example.com", schema.UserRole.Admin);

      createComment(base.instructor.id, lessonId, "Instructor here");
      createComment(admin.id, lessonId, "Admin here");

      expect(getCommentsForLesson(lessonId)).toHaveLength(2);
    });

    it("rejects students who are not enrolled", () => {
      expect(() => createComment(base.user.id, lessonId, "Hi")).toThrow();
    });

    it("rejects empty comments", () => {
      enroll(base.user.id, base.course.id);

      expect(() => createComment(base.user.id, lessonId, "   ")).toThrow();
    });

    it(`accepts ${MAX_COMMENT_LENGTH} characters and rejects more`, () => {
      enroll(base.user.id, base.course.id);

      expect(() =>
        createComment(base.user.id, lessonId, "a".repeat(MAX_COMMENT_LENGTH))
      ).not.toThrow();
      expect(() =>
        createComment(
          base.user.id,
          lessonId,
          "a".repeat(MAX_COMMENT_LENGTH + 1)
        )
      ).toThrow();
    });
  });

  describe("getCommentsForLesson", () => {
    it("returns comments oldest first with author info", () => {
      enroll(base.user.id, base.course.id);
      createComment(base.user.id, lessonId, "First");
      createComment(base.instructor.id, lessonId, "Second");

      const comments = getCommentsForLesson(lessonId);

      expect(comments.map((c) => c.content)).toEqual(["First", "Second"]);
      expect(comments[0].authorName).toBe("Test User");
      expect(comments[1].authorName).toBe("Test Instructor");
    });

    it("does not return comments from other lessons", () => {
      enroll(base.user.id, base.course.id);
      const otherLesson = createLesson(base.course.id);
      createComment(base.user.id, otherLesson.id, "Elsewhere");

      expect(getCommentsForLesson(lessonId)).toHaveLength(0);
    });
  });

  describe("deleteComment", () => {
    it("lets the author soft delete their own comment", () => {
      enroll(base.user.id, base.course.id);
      const comment = createComment(base.user.id, lessonId, "Oops");

      deleteComment(base.user.id, comment.id);

      const raw = getRawComment(comment.id);
      expect(raw?.deletedAt).not.toBeNull();
      expect(raw?.deletedBy).toBe(base.user.id);
      expect(raw?.content).toBe("Oops");
    });

    it("hides the content of deleted comments but keeps them in the list", () => {
      enroll(base.user.id, base.course.id);
      const comment = createComment(base.user.id, lessonId, "Oops");

      deleteComment(base.user.id, comment.id);

      const [listed] = getCommentsForLesson(lessonId);
      expect(listed.deleted).toBe(true);
      expect(listed.content).toBeNull();
    });

    it("lets the course instructor and admins delete any comment", () => {
      const admin = createUser("admin@example.com", schema.UserRole.Admin);
      enroll(base.user.id, base.course.id);
      const first = createComment(base.user.id, lessonId, "One");
      const second = createComment(base.user.id, lessonId, "Two");

      deleteComment(base.instructor.id, first.id);
      deleteComment(admin.id, second.id);

      expect(getCommentsForLesson(lessonId).every((c) => c.deleted)).toBe(
        true
      );
    });

    it("does not let another student delete someone else's comment", () => {
      const other = createUser("other@example.com", schema.UserRole.Student);
      enroll(base.user.id, base.course.id);
      enroll(other.id, base.course.id);
      const comment = createComment(base.user.id, lessonId, "Mine");

      expect(() => deleteComment(other.id, comment.id)).toThrow();
      expect(getRawComment(comment.id)?.deletedAt).toBeNull();
    });

    it("does not let another course's instructor delete a comment", () => {
      const otherInstructor = createUser(
        "other@example.com",
        schema.UserRole.Instructor
      );
      enroll(base.user.id, base.course.id);
      const comment = createComment(base.user.id, lessonId, "Mine");

      expect(() => deleteComment(otherInstructor.id, comment.id)).toThrow();
    });

    it("rejects deleting a comment twice", () => {
      enroll(base.user.id, base.course.id);
      const comment = createComment(base.user.id, lessonId, "Oops");

      deleteComment(base.user.id, comment.id);

      expect(() => deleteComment(base.user.id, comment.id)).toThrow();
    });
  });
});
