import { eq, asc } from "drizzle-orm";
import { db } from "~/db";
import {
  courses,
  lessonComments,
  lessons,
  modules,
  users,
  UserRole,
} from "~/db/schema";
import { isUserEnrolled } from "~/services/enrollmentService";
import { getUserById } from "~/services/userService";
import { MAX_COMMENT_LENGTH } from "~/lib/comments";

// ─── Comment Service ───
// Handles flat, immutable comments on lessons. Deletion is a soft delete
// (deletedAt is set and the row is kept). Comments are visible to and can be
// posted by enrolled students, the course instructor and admins.
// Uses positional parameters (project convention).

export { MAX_COMMENT_LENGTH };

export type LessonComment = {
  id: number;
  userId: number;
  authorName: string;
  authorAvatarUrl: string | null;
  content: string | null;
  createdAt: string;
  deleted: boolean;
};

function getCourseIdForLesson(lessonId: number) {
  const row = db
    .select({ courseId: modules.courseId })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(lessons.id, lessonId))
    .get();

  return row?.courseId ?? null;
}

export function canModerateCourseComments(userId: number, courseId: number) {
  const user = getUserById(userId);
  if (!user) return false;
  if (user.role === UserRole.Admin) return true;

  const course = db
    .select({ instructorId: courses.instructorId })
    .from(courses)
    .where(eq(courses.id, courseId))
    .get();

  return course?.instructorId === userId;
}

export function canAccessLessonComments(userId: number, courseId: number) {
  return (
    isUserEnrolled(userId, courseId) ||
    canModerateCourseComments(userId, courseId)
  );
}

export function getCommentsForLesson(lessonId: number): LessonComment[] {
  const rows = db
    .select({
      id: lessonComments.id,
      userId: lessonComments.userId,
      authorName: users.name,
      authorAvatarUrl: users.avatarUrl,
      content: lessonComments.content,
      createdAt: lessonComments.createdAt,
      deletedAt: lessonComments.deletedAt,
    })
    .from(lessonComments)
    .innerJoin(users, eq(lessonComments.userId, users.id))
    .where(eq(lessonComments.lessonId, lessonId))
    .orderBy(asc(lessonComments.createdAt), asc(lessonComments.id))
    .all();

  // Strip the content of removed comments so it never reaches the client
  return rows.map(({ deletedAt, ...row }) => ({
    ...row,
    content: deletedAt ? null : row.content,
    deleted: deletedAt !== null,
  }));
}

export function getCommentById(commentId: number) {
  return db
    .select()
    .from(lessonComments)
    .where(eq(lessonComments.id, commentId))
    .get();
}

export function createComment(
  userId: number,
  lessonId: number,
  content: string
) {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error("Comment cannot be empty");
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new Error(
      `Comment must be at most ${MAX_COMMENT_LENGTH} characters`
    );
  }

  const courseId = getCourseIdForLesson(lessonId);
  if (courseId === null) {
    throw new Error("Lesson not found");
  }

  if (!canAccessLessonComments(userId, courseId)) {
    throw new Error("Only enrolled students and course staff can comment");
  }

  return db
    .insert(lessonComments)
    .values({ userId, lessonId, content: trimmed })
    .returning()
    .get();
}

export function deleteComment(userId: number, commentId: number) {
  const comment = getCommentById(commentId);
  if (!comment || comment.deletedAt) {
    throw new Error("Comment not found");
  }

  const courseId = getCourseIdForLesson(comment.lessonId);
  const isAuthor = comment.userId === userId;
  if (
    !isAuthor &&
    (courseId === null || !canModerateCourseComments(userId, courseId))
  ) {
    throw new Error("You can only delete your own comments");
  }

  return db
    .update(lessonComments)
    .set({ deletedAt: new Date().toISOString(), deletedBy: userId })
    .where(eq(lessonComments.id, commentId))
    .returning()
    .get();
}
