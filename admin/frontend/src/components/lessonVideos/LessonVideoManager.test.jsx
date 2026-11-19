import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import LessonVideoManager from './LessonVideoManager';

const ID = 'dQw4w9WgXcQ';

function course() {
  return {
    slug: 'prarambh',
    title: 'PRARAMBH',
    modules: [
      {
        moduleId: 'mod-1',
        title: 'Awakening',
        lessons: [
          { lessonId: 'l-1', title: 'Welcome', isPublished: true, video: null, legacyVideoUrl: '/PRARAMBH.mp4' },
          {
            lessonId: 'l-2',
            title: 'Archetypes',
            isPublished: true,
            video: { videoId: ID, originalUrl: `https://youtu.be/${ID}`, title: 'Archetypes video', isPublished: false, availability: 'available' },
            legacyVideoUrl: '',
          },
        ],
      },
    ],
  };
}

function makeApi(overrides = {}) {
  return {
    listCourses: vi.fn().mockResolvedValue([
      { slug: 'prarambh', title: 'PRARAMBH', isPublished: true },
      { slug: 'garud', title: 'GARUD', isPublished: true },
    ]),
    getCourse: vi.fn().mockImplementation(async (slug) => (slug === 'prarambh' ? course() : { slug, title: slug, modules: [] })),
    inspect: vi.fn().mockResolvedValue({ availability: 'available', title: 'From YouTube' }),
    save: vi.fn().mockImplementation(async (slug, target, p) => ({ video: { videoId: ID, originalUrl: p.url, title: p.title, isPublished: p.isPublished, availability: 'available' } })),
    remove: vi.fn().mockResolvedValue({ removed: true }),
    ...overrides,
  };
}

afterEach(cleanup);

describe('LessonVideoManager', () => {
  it('lists modules and lessons with each lesson’s video state', async () => {
    const api = makeApi();
    render(<LessonVideoManager api={api} heading="Lesson Videos" description="" emptyMessage="none" />);
    expect(await screen.findByText('Welcome')).toBeInTheDocument();
    expect(api.getCourse).toHaveBeenCalledWith('prarambh');
    expect(screen.getByTestId('status-l-1')).toHaveTextContent('Hosted file');
    expect(screen.getByTestId('status-l-2')).toHaveTextContent('Draft');
    expect(within(screen.getByText('Welcome').closest('li')).getByRole('button', { name: 'Add video' })).toBeInTheDocument();
    expect(within(screen.getByText('Archetypes').closest('li')).getByRole('button', { name: 'Edit video' })).toBeInTheDocument();
  });

  it('publishing from the inline editor updates the row without reloading the course', async () => {
    const api = makeApi();
    render(<LessonVideoManager api={api} heading="Lesson Videos" description="" emptyMessage="none" />);
    fireEvent.click(within((await screen.findByText('Welcome')).closest('li')).getByRole('button', { name: 'Add video' }));

    const editor = screen.getByTestId('lesson-video-editor');
    expect(within(editor).getByText(/directly-hosted file/)).toBeInTheDocument();
    fireEvent.change(within(editor).getByLabelText('YouTube video URL'), { target: { value: `https://youtu.be/${ID}` } });
    await waitFor(() => expect(within(editor).getByTestId('video-status')).toHaveTextContent(/Valid/));
    fireEvent.click(within(editor).getByRole('button', { name: /^Publish$/ }));

    await waitFor(() => expect(api.save).toHaveBeenCalledWith('prarambh', { lessonId: 'l-1' }, expect.objectContaining({ isPublished: true })));
    expect(await screen.findByRole('status')).toHaveTextContent(/video published/);
    expect(screen.getByTestId('status-l-1')).toHaveTextContent('Published');
    expect(api.getCourse).toHaveBeenCalledTimes(1);
  });

  it('a module gets its own introduction video row and editor', async () => {
    const api = makeApi();
    render(<LessonVideoManager api={api} heading="Lesson Videos" description="" emptyMessage="none" />);
    const intro = await screen.findByTestId('module-intro-mod-1');
    fireEvent.click(within(intro).getByRole('button', { name: 'Add video' }));
    const editor = screen.getByTestId('lesson-video-editor');
    expect(within(editor).getByText('Module introduction video')).toBeInTheDocument();
    fireEvent.change(within(editor).getByLabelText('YouTube video URL'), { target: { value: `https://youtu.be/${ID}` } });
    await waitFor(() => expect(within(editor).getByTestId('video-status')).toHaveTextContent(/Valid/));
    fireEvent.click(within(editor).getByRole('button', { name: /^Publish$/ }));
    await waitFor(() =>
      expect(api.save).toHaveBeenCalledWith('prarambh', { moduleId: 'mod-1' }, expect.objectContaining({ isPublished: true, expectedUpdatedAt: null }))
    );
    expect(await screen.findByTestId('status-module-mod-1')).toHaveTextContent('Published');
  });

  it('after a conflict, the row shows the current version and the editor reopens on it', async () => {
    const current = {
      videoId: 'M7lc1UVf-VE',
      originalUrl: 'https://youtu.be/M7lc1UVf-VE',
      title: 'Theirs',
      isPublished: true,
      availability: 'available',
      updatedAt: '2026-11-02T00:00:00Z',
    };
    const api = makeApi({
      save: vi.fn().mockRejectedValue(Object.assign(new Error('This video was changed by Alice Rao since you opened it.'), { status: 409, details: { current } })),
    });
    render(<LessonVideoManager api={api} heading="H" description="" emptyMessage="none" />);
    const row = (await screen.findByText('Welcome')).closest('li');
    fireEvent.click(within(row).getByRole('button', { name: 'Add video' }));
    fireEvent.change(screen.getByLabelText('YouTube video URL'), { target: { value: `https://youtu.be/${ID}` } });
    await waitFor(() => expect(screen.getByTestId('video-status')).toHaveTextContent(/Valid/));
    fireEvent.click(screen.getByRole('button', { name: /^Publish$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load the current version' }));
    expect(screen.getByTestId('status-l-1')).toHaveTextContent('Published');
    expect(screen.getByLabelText('YouTube video URL')).toHaveValue('https://youtu.be/M7lc1UVf-VE');
    expect(screen.getByLabelText('Video title')).toHaveValue('Theirs');
  });

  it('switching course loads that course', async () => {
    const api = makeApi();
    render(<LessonVideoManager api={api} heading="Lesson Videos" description="" emptyMessage="none" />);
    await screen.findByText('Welcome');
    fireEvent.change(screen.getByLabelText('Course'), { target: { value: 'garud' } });
    await waitFor(() => expect(api.getCourse).toHaveBeenCalledWith('garud'));
    expect(await screen.findByText(/has no modules or lessons yet/)).toBeInTheDocument();
  });

  it('shows the empty message when no course is available', async () => {
    render(<LessonVideoManager api={makeApi({ listCourses: vi.fn().mockResolvedValue([]) })} heading="H" description="" emptyMessage="No courses assigned" />);
    expect(await screen.findByText('No courses assigned')).toBeInTheDocument();
  });

  it('shows a load failure instead of an empty page', async () => {
    const api = makeApi({ listCourses: vi.fn().mockRejectedValue(new Error('The Student service is unavailable')) });
    render(<LessonVideoManager api={api} heading="H" description="" emptyMessage="none" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The Student service is unavailable');
  });
});

/**
 * The Teacher portal renders the same components. If its copies drift, a
 * teacher and an administrator would see different rules for the same link.
 */
describe('shared lesson-video components', () => {
  it('are identical in the Teacher portal', () => {
    for (const file of ['LessonVideoEditor.jsx', 'LessonVideoManager.jsx', 'YouTubeThumbnail.jsx']) {
      const mine = resolve(__dirname, file);
      const theirs = resolve(__dirname, '../../../../../teacher/frontend/src/components/lessonVideos', file);
      if (!existsSync(theirs)) continue;
      const norm = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
      expect(norm(theirs), `${file} differs between admin and teacher`).toBe(norm(mine));
    }
    const studentThumb = resolve(__dirname, '../../../../../student/frontend/src/components/student/YouTubeThumbnail.jsx');
    if (existsSync(studentThumb)) {
      expect(readFileSync(studentThumb, 'utf8').replace(/\r\n/g, '\n')).toBe(
        readFileSync(resolve(__dirname, 'YouTubeThumbnail.jsx'), 'utf8').replace(/\r\n/g, '\n')
      );
    }
  });
});
