import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import LessonVideoEditor from './LessonVideoEditor';

const ID = 'dQw4w9WgXcQ';
const lesson = { lessonId: 'l-1', title: 'Welcome', video: null, legacyVideoUrl: '' };

function setup({ lessonOverride = {}, inspect, save, remove } = {}) {
  const api = {
    inspect: inspect || vi.fn().mockResolvedValue({ videoId: ID, availability: 'available', title: 'Never Gonna Give You Up' }),
    save: save || vi.fn().mockImplementation(async (p) => ({ video: { videoId: ID, ...p } })),
    remove: remove || vi.fn().mockResolvedValue({ removed: true }),
  };
  const onSaved = vi.fn();
  const onRemoved = vi.fn();
  render(<LessonVideoEditor lesson={{ ...lesson, ...lessonOverride }} api={api} onSaved={onSaved} onRemoved={onRemoved} onClose={() => {}} />);
  return { api, onSaved, onRemoved, urlInput: screen.getByLabelText('YouTube video URL') };
}

const type = (input, value) => fireEvent.change(input, { target: { value } });
const status = () => screen.getByTestId('video-status').textContent;
const publishButton = () => screen.getByRole('button', { name: /^Publish$/ });

afterEach(cleanup);

describe('LessonVideoEditor', () => {
  it('starts empty with guidance and nothing to publish', () => {
    setup();
    expect(status()).toMatch(/Paste a YouTube link/);
    expect(publishButton()).toBeDisabled();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('explains an invalid link immediately and never asks the server about it', async () => {
    const { api, urlInput } = setup();
    type(urlInput, 'https://vimeo.com/12345');
    expect(status()).toMatch(/Only YouTube links are supported/);
    expect(urlInput).toHaveAttribute('aria-invalid', 'true');
    expect(publishButton()).toBeDisabled();

    type(urlInput, 'https://www.youtube.com/watch?v=short');
    expect(status()).toMatch(/malformed video id/);
    await new Promise((r) => setTimeout(r, 650));
    expect(api.inspect).not.toHaveBeenCalled();
  });

  it('shows the thumbnail as soon as a valid link is typed, then checks it and fills the title', async () => {
    const { api, urlInput } = setup();
    type(urlInput, `https://youtu.be/${ID}`);

    const img = screen.getByTestId('video-preview').querySelector('img');
    expect(img.getAttribute('src')).toBe(`https://img.youtube.com/vi/${ID}/maxresdefault.jpg`);
    expect(status()).toMatch(/Checking with YouTube/);

    await waitFor(() => expect(api.inspect).toHaveBeenCalledTimes(1));
    expect(api.inspect.mock.calls[0][0]).toBe(`https://youtu.be/${ID}`);
    await waitFor(() => expect(status()).toMatch(/Valid YouTube video/));
    expect(screen.getByLabelText('Video title')).toHaveValue('Never Gonna Give You Up');
    expect(publishButton()).toBeEnabled();
  });

  it('does not overwrite a title the editor typed', async () => {
    const { api, urlInput } = setup();
    fireEvent.change(screen.getByLabelText('Video title'), { target: { value: 'My own title' } });
    type(urlInput, `https://youtu.be/${ID}`);
    await waitFor(() => expect(api.inspect).toHaveBeenCalled());
    await waitFor(() => expect(status()).toMatch(/Valid/));
    expect(screen.getByLabelText('Video title')).toHaveValue('My own title');
  });

  it('falls back from maxres to hq, then to a placeholder, without a broken image', async () => {
    const { urlInput } = setup({ inspect: vi.fn().mockResolvedValue({ availability: 'unknown' }) });
    type(urlInput, `https://youtu.be/${ID}`);
    const preview = screen.getByTestId('video-preview');

    fireEvent.error(preview.querySelector('img'));
    expect(preview.querySelector('img').getAttribute('src')).toBe(`https://img.youtube.com/vi/${ID}/hqdefault.jpg`);

    // YouTube's "no such thumbnail" answer is a 120px grey image, not an error.
    const hq = preview.querySelector('img');
    Object.defineProperty(hq, 'naturalWidth', { value: 120 });
    fireEvent.load(hq);
    expect(preview.querySelector('img')).toBeNull();
    expect(screen.getByTestId('yt-thumb-fallback')).toBeInTheDocument();
    await waitFor(() => expect(status()).toMatch(/cannot find a public video/));
    expect(publishButton()).toBeDisabled();
  });

  it('previews in a privacy-enhanced, sandboxed embed only when asked', () => {
    const { urlInput } = setup();
    type(urlInput, `https://www.youtube.com/shorts/${ID}`);
    expect(document.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Preview video' }));
    const frame = document.querySelector('iframe');
    expect(frame.getAttribute('src')).toMatch(new RegExp(`^https://www\\.youtube-nocookie\\.com/embed/${ID}\\?`));
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.hasAttribute('allowfullscreen')).toBe(true);
  });

  it('publishes with trimmed fields and reports back', async () => {
    const { api, onSaved, urlInput } = setup();
    type(urlInput, `  https://youtu.be/${ID}  `);
    await waitFor(() => expect(status()).toMatch(/Valid/));
    fireEvent.change(screen.getByLabelText('Video title'), { target: { value: '  Welcome  ' } });
    fireEvent.click(screen.getByLabelText('Open on YouTube'));
    fireEvent.click(publishButton());

    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect(api.save).toHaveBeenCalledWith({
      url: `https://youtu.be/${ID}`,
      title: 'Welcome',
      description: '',
      playbackMode: 'external',
      isPublished: true,
      // A new video: the save says "there was none", so a concurrent add is caught.
      expectedUpdatedAt: null,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ videoId: ID }), 'publish'));
  });

  it('saves a draft without publishing', async () => {
    const { api, urlInput } = setup();
    type(urlInput, `https://youtu.be/${ID}`);
    fireEvent.click(screen.getByRole('button', { name: /Save draft/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ isPublished: false })));
  });

  it('keeps an unavailable video as a draft only', async () => {
    const { urlInput } = setup({ inspect: vi.fn().mockResolvedValue({ availability: 'unavailable' }) });
    type(urlInput, `https://youtu.be/${ID}`);
    await waitFor(() => expect(status()).toMatch(/cannot find a public video/));
    expect(publishButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save draft/ })).toBeEnabled();
  });

  it('warns when embedding is disabled but still allows publishing', async () => {
    const { urlInput } = setup({ inspect: vi.fn().mockResolvedValue({ availability: 'restricted' }) });
    type(urlInput, `https://youtu.be/${ID}`);
    await waitFor(() => expect(status()).toMatch(/embedding is disabled/));
    expect(publishButton()).toBeEnabled();
  });

  it('shows the server refusal when a save fails', async () => {
    const save = vi.fn().mockRejectedValue(Object.assign(new Error('This course has not been assigned to you.'), { status: 403 }));
    const { urlInput } = setup({ save });
    type(urlInput, `https://youtu.be/${ID}`);
    await waitFor(() => expect(status()).toMatch(/Valid/));
    fireEvent.click(publishButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('This course has not been assigned to you.');
  });

  it('edits a published video: unpublish, and remove only after confirming', async () => {
    const saved = {
      videoId: ID,
      originalUrl: `https://youtu.be/${ID}`,
      title: 'Welcome',
      description: '',
      playbackMode: 'embed',
      isPublished: true,
      availability: 'available',
      updatedAt: '2026-11-01T10:00:00Z',
      updatedBy: { portal: 'teacher', name: 'Alice Rao' },
    };
    const { api, onRemoved } = setup({ lessonOverride: { video: saved } });
    expect(api.inspect).not.toHaveBeenCalled();
    expect(screen.getByText(/by Alice Rao \(teacher\)/)).toBeInTheDocument();
    // Nothing changed yet, so there is nothing to re-publish.
    expect(screen.getByRole('button', { name: /Update published video/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Unpublish/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ isPublished: false })));

    fireEvent.click(screen.getByRole('button', { name: /Remove video/ }));
    expect(api.remove).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Yes, remove/ }));
    });
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledWith({ expectedUpdatedAt: '2026-11-01T10:00:00Z' });
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ expectedUpdatedAt: '2026-11-01T10:00:00Z' }));
    expect(onRemoved).toHaveBeenCalled();
  });

  it('on a version conflict, saves nothing and offers the current version', async () => {
    const current = { videoId: ID, title: 'Their title', updatedAt: '2026-11-02T00:00:00Z' };
    const save = vi.fn().mockRejectedValue(
      Object.assign(new Error('This video was changed by Alice Rao since you opened it.'), { status: 409, code: 'VIDEO_CHANGED', details: { current } })
    );
    const onConflict = vi.fn();
    const api = { inspect: vi.fn().mockResolvedValue({ availability: 'available' }), save, remove: vi.fn() };
    render(<LessonVideoEditor lesson={lesson} api={api} onConflict={onConflict} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('YouTube video URL'), { target: { value: `https://youtu.be/${ID}` } });
    await waitFor(() => expect(status()).toMatch(/Valid/));
    fireEvent.click(publishButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed by Alice Rao/);
    fireEvent.click(screen.getByRole('button', { name: 'Load the current version' }));
    expect(onConflict).toHaveBeenCalledWith(current);
  });

  it('reads the admin client conflict shape too (errors.current)', async () => {
    const current = { videoId: ID, title: 'x' };
    const save = vi.fn().mockRejectedValue(Object.assign(new Error('changed'), { status: 409, errors: { current } }));
    const onConflict = vi.fn();
    render(
      <LessonVideoEditor
        lesson={lesson}
        api={{ inspect: vi.fn().mockResolvedValue({ availability: 'available' }), save, remove: vi.fn() }}
        onConflict={onConflict}
        onClose={() => {}}
      />
    );
    fireEvent.change(screen.getByLabelText('YouTube video URL'), { target: { value: `https://youtu.be/${ID}` } });
    await waitFor(() => expect(status()).toMatch(/Valid/));
    fireEvent.click(publishButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Load the current version' }));
    expect(onConflict).toHaveBeenCalledWith(current);
  });

  it('labels a module introduction as such', () => {
    render(
      <LessonVideoEditor
        lesson={{ kind: 'module', lessonId: 'mod-1', title: 'Awakening', video: null }}
        api={{ inspect: vi.fn(), save: vi.fn(), remove: vi.fn() }}
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Module introduction video')).toBeInTheDocument();
  });
});
