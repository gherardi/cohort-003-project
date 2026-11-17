import { eq, and } from "drizzle-orm";
import { db } from "~/db";
import { lessonBookmarks, lessons, modules } from "~/db/schema";

// ─── Bookmark Service ───
// Handles private lesson bookmarks: one bookmark per student per lesson.
// Uses positional parameters (project convention).

export function isLessonBookmarked(userId: number, lessonId: number) {
  const row = db
    .select({ id: lessonBookmarks.id })
    .from(lessonBookmarks)
    .where(
      and(
        eq(lessonBookmarks.userId, userId),
        eq(lessonBookmarks.lessonId, lessonId)
      )
    )
    .get();

  return row !== undefined;
}

export function toggleBookmark(userId: number, lessonId: number) {
  const removed = db
    .delete(lessonBookmarks)
    .where(
      and(
        eq(lessonBookmarks.userId, userId),
        eq(lessonBookmarks.lessonId, lessonId)
      )
    )
    .returning()
    .get();

  if (removed) {
    return { bookmarked: false };
  }

  db.insert(lessonBookmarks)
    .values({ userId, lessonId })
    .onConflictDoNothing()
    .run();

  return { bookmarked: true };
}

export function getBookmarkedLessonIds(userId: number, courseId: number) {
  const rows = db
    .select({ lessonId: lessonBookmarks.lessonId })
    .from(lessonBookmarks)
    .innerJoin(lessons, eq(lessonBookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(
      and(eq(lessonBookmarks.userId, userId), eq(modules.courseId, courseId))
    )
    .all();

  return rows.map((row) => row.lessonId);
}
