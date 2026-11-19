import React, { useEffect, useState } from 'react';
import LessonVideoManager from '../components/lessonVideos/LessonVideoManager';
import { teacherApiService } from '../services/teacherApiService';
import { socketService } from '../services/socketService';

/**
 * YouTube videos on the lessons of the courses an administrator has assigned
 * to this teacher. The list and every save are scoped by the backend's own
 * assignment records; this page only shows what it is given.
 */

const API = {
  listCourses: () => teacherApiService.getLessonVideoCourses(),
  getCourse: (slug) => teacherApiService.getLessonVideos(slug),
  inspect: (url, opts) => teacherApiService.inspectLessonVideo(url, opts),
  save: (slug, target, payload) => teacherApiService.saveCourseVideo(slug, target, payload),
  remove: (slug, target, payload) => teacherApiService.removeCourseVideo(slug, target, payload),
};

export default function LessonVideosPage() {
  // An administrator assigning or removing a course reloads the list live.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    socketService.connect();
    const bump = () => setGeneration((g) => g + 1);
    const offs = ['course.access_changed', 'course.assigned', 'course.unassigned'].map((e) => socketService.on(e, bump));
    return () => offs.forEach((off) => off());
  }, []);

  return (
    <LessonVideoManager
      key={generation}
      api={API}
      heading="Lesson Videos"
      description="Add YouTube videos to the lessons of your assigned courses. Students see a video once it is published."
      emptyMessage="No courses have been assigned to you yet. An administrator assigns courses from the Admin portal."
    />
  );
}
