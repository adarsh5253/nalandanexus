import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react';

const ID = 'dQw4w9WgXcQ';
const listeners = {};

const api = {
  getLessonVideoCourses: vi.fn(),
  getLessonVideos: vi.fn(),
  inspectLessonVideo: vi.fn(),
  saveCourseVideo: vi.fn(),
  removeCourseVideo: vi.fn(),
};

vi.mock('../services/teacherApiService', () => ({ teacherApiService: api }));
vi.mock('../services/socketService', () => ({
  socketService: {
    connect: vi.fn(),
    on: vi.fn((event, fn) => {
      listeners[event] = fn;
      return () => delete listeners[event];
    }),
  },
}));

const { default: LessonVideosPage } = await import('./LessonVideosPage');

const garud = {
  slug: 'garud',
  title: 'GARUD',
  modules: [{ moduleId: 'g-mod-1', title: 'Flight', lessons: [{ lessonId: 'g-1', title: 'Lift-off', isPublished: true, video: null, legacyVideoUrl: '' }] }],
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getLessonVideoCourses.mockResolvedValue([{ slug: 'garud', title: 'GARUD', isPublished: true }]);
  api.getLessonVideos.mockResolvedValue(garud);
  api.inspectLessonVideo.mockResolvedValue({ availability: 'available', title: 'Lift-off explained' });
  api.saveCourseVideo.mockImplementation(async (slug, target, p) => ({ video: { videoId: ID, originalUrl: p.url, title: p.title, isPublished: p.isPublished, availability: 'available' } }));
});
afterEach(cleanup);

describe('Teacher Lesson Videos page', () => {
  it('shows only the courses the backend says are assigned', async () => {
    render(<LessonVideosPage />);
    expect(await screen.findByText('Lift-off')).toBeInTheDocument();
    const options = within(screen.getByLabelText('Course')).getAllByRole('option').map((o) => o.value);
    expect(options).toEqual(['garud']);
  });

  it('adds and publishes a video through the teacher API', async () => {
    render(<LessonVideosPage />);
    fireEvent.click(within((await screen.findByText('Lift-off')).closest('li')).getByRole('button', { name: 'Add video' }));
    fireEvent.change(screen.getByLabelText('YouTube video URL'), { target: { value: `https://www.youtube.com/live/${ID}` } });
    await waitFor(() => expect(screen.getByTestId('video-status')).toHaveTextContent(/Valid/));
    expect(screen.getByLabelText('Video title')).toHaveValue('Lift-off explained');
    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }));
    await waitFor(() =>
      expect(api.saveCourseVideo).toHaveBeenCalledWith('garud', { lessonId: 'g-1' }, expect.objectContaining({ url: `https://www.youtube.com/live/${ID}`, isPublished: true }))
    );
    expect(await screen.findByTestId('status-g-1')).toHaveTextContent('Published');
  });

  it('explains when nothing is assigned', async () => {
    api.getLessonVideoCourses.mockResolvedValue([]);
    render(<LessonVideosPage />);
    expect(await screen.findByText(/No courses have been assigned to you yet/)).toBeInTheDocument();
    expect(api.getLessonVideos).not.toHaveBeenCalled();
  });

  it('reloads when an administrator changes this teacher’s assignments', async () => {
    render(<LessonVideosPage />);
    await screen.findByText('Lift-off');
    api.getLessonVideoCourses.mockResolvedValue([]);
    await act(async () => {
      listeners['course.access_changed']({ added: [], removed: ['garud'] });
    });
    expect(await screen.findByText(/No courses have been assigned to you yet/)).toBeInTheDocument();
  });

  it('surfaces a refusal from the backend', async () => {
    api.saveCourseVideo.mockRejectedValue(Object.assign(new Error('This course has not been assigned to you, so you cannot manage its videos.'), { status: 403 }));
    render(<LessonVideosPage />);
    fireEvent.click(within((await screen.findByText('Lift-off')).closest('li')).getByRole('button', { name: 'Add video' }));
    fireEvent.change(screen.getByLabelText('YouTube video URL'), { target: { value: `https://youtu.be/${ID}` } });
    await waitFor(() => expect(screen.getByTestId('video-status')).toHaveTextContent(/Valid/));
    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/not been assigned to you/);
  });
});
