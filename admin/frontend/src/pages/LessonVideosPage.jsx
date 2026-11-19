import React from 'react';
import LessonVideoManager from '../components/lessonVideos/LessonVideoManager';
import { adminApi } from '../services/adminApi';

/**
 * YouTube videos on every course's lessons - PRARAMBH, GARUD, YODDHA and any
 * course bridged from this portal. The backend route sits behind
 * `courses.manage`, like Course Subjects.
 */

// Module-level so the manager's effects see one stable object across renders.
const API = {
  listCourses: () => adminApi.getLessonVideoCourses(),
  getCourse: (slug) => adminApi.getLessonVideos(slug),
  inspect: (url, opts) => adminApi.inspectLessonVideo(url, opts),
  save: (slug, target, payload) => adminApi.saveCourseVideo(slug, target, payload),
  remove: (slug, target, payload) => adminApi.removeCourseVideo(slug, target, payload),
};

export default function LessonVideosPage() {
  return (
    <LessonVideoManager
      api={API}
      heading="Lesson Videos"
      description="Attach a YouTube video to any lesson, or an introduction video to any module. Thumbnails are picked up automatically; students see a video only once it is published."
      emptyMessage="No courses were found in the student catalogue."
    />
  );
}
