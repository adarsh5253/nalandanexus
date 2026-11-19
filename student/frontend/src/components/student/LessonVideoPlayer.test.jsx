import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import LessonVideoPlayer from './LessonVideoPlayer';

const ID = 'dQw4w9WgXcQ';
const video = (over = {}) => ({ provider: 'youtube', videoId: ID, title: 'Welcome to Nalanda', description: '', playbackMode: 'embed', embeddable: true, ...over });

afterEach(cleanup);

describe('LessonVideoPlayer', () => {
  it('shows the real thumbnail and a play button, and loads no player yet', () => {
    render(<LessonVideoPlayer video={video()} lessonTitle="Lesson 1" />);
    const img = screen.getByTestId('lesson-video-player').querySelector('img');
    expect(img.getAttribute('src')).toBe(`https://img.youtube.com/vi/${ID}/maxresdefault.jpg`);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(screen.getByRole('button', { name: 'Play video: Welcome to Nalanda' })).toBeInTheDocument();
    expect(screen.getByText('Welcome to Nalanda')).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('plays inside the page in a privacy-enhanced, sandboxed, fullscreen-capable embed', () => {
    render(<LessonVideoPlayer video={video()} />);
    fireEvent.click(screen.getByRole('button', { name: /Play video/ }));
    const frame = document.querySelector('iframe');
    expect(frame).not.toBeNull();
    const src = new URL(frame.getAttribute('src'));
    expect(src.origin).toBe('https://www.youtube-nocookie.com');
    expect(src.pathname).toBe(`/embed/${ID}`);
    expect(src.searchParams.get('autoplay')).toBe('1');
    expect(frame.hasAttribute('allowfullscreen')).toBe(true);
    expect(frame.getAttribute('sandbox')).toMatch(/allow-scripts/);
    expect(frame.getAttribute('title')).toBe('Welcome to Nalanda');
  });

  it('falls back to hqdefault when the HD thumbnail is missing', () => {
    render(<LessonVideoPlayer video={video()} />);
    const player = screen.getByTestId('lesson-video-player');
    const maxres = player.querySelector('img');
    Object.defineProperty(maxres, 'naturalWidth', { value: 120 });
    fireEvent.load(maxres);
    expect(player.querySelector('img').getAttribute('src')).toBe(`https://img.youtube.com/vi/${ID}/hqdefault.jpg`);
  });

  it('when embedding is disabled, explains it and offers YouTube instead of a blank player', () => {
    render(<LessonVideoPlayer video={video({ embeddable: false })} />);
    expect(screen.queryByRole('button', { name: /Play video/ })).toBeNull();
    expect(screen.getByText(/can’t be played here - its owner has turned off playback on other websites, or made it private/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Watch on YouTube/ });
    expect(link).toHaveAttribute('href', `https://www.youtube.com/watch?v=${ID}`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('honours an "open on YouTube" playback mode', () => {
    render(<LessonVideoPlayer video={video({ playbackMode: 'external' })} />);
    expect(screen.queryByRole('button', { name: /Play video/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Watch on YouTube/ })).toBeInTheDocument();
    expect(screen.queryByText(/does not allow/)).toBeNull();
  });

  it('always offers Open on YouTube beneath the player', () => {
    render(<LessonVideoPlayer video={video()} />);
    expect(screen.getByRole('link', { name: /Open on YouTube/ })).toHaveAttribute('href', `https://www.youtube.com/watch?v=${ID}`);
  });

  it('renders nothing for a missing or tampered video id - never an arbitrary iframe', () => {
    const { container, rerender } = render(<LessonVideoPlayer video={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<LessonVideoPlayer video={video({ videoId: '"><script>x' })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<LessonVideoPlayer video={video({ videoId: ID, embedUrl: 'https://evil.example/frame' })} />);
    fireEvent.click(screen.getByRole('button', { name: /Play video/ }));
    expect(document.querySelector('iframe').getAttribute('src')).not.toMatch(/evil/);
  });

  it('escapes titles rather than rendering them as markup', () => {
    render(<LessonVideoPlayer video={video({ title: '<img src=x onerror=alert(1)>' })} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(screen.getByTestId('lesson-video-player').querySelectorAll('img')).toHaveLength(1);
  });

  describe('failures while playing', () => {
    const post = (frame, data, { origin = 'https://www.youtube-nocookie.com', source = frame.contentWindow } = {}) =>
      act(() => {
        window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), origin, source }));
      });

    it('asks the player for its events, addressed only to YouTube', () => {
      render(<LessonVideoPlayer video={video()} />);
      fireEvent.click(screen.getByRole('button', { name: /Play video/ }));
      const frame = document.querySelector('iframe');
      expect(new URL(frame.src).searchParams.get('enablejsapi')).toBe('1');
      expect(new URL(frame.src).searchParams.get('origin')).toBe(window.location.origin);
      const spy = vi.spyOn(frame.contentWindow, 'postMessage');
      fireEvent.load(frame);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('"listening"'), 'https://www.youtube-nocookie.com');
    });

    it('replaces the frame with the YouTube fallback when embedding turns out to be disabled', () => {
      render(<LessonVideoPlayer video={video()} />);
      fireEvent.click(screen.getByRole('button', { name: /Play video/ }));
      const frame = document.querySelector('iframe');
      post(frame, { event: 'onError', info: 150 });
      expect(document.querySelector('iframe')).toBeNull();
      expect(screen.getByRole('alert')).toHaveTextContent(/can’t be played here - its owner has turned off playback on other websites, or made it private/);
      expect(screen.getByRole('link', { name: /Watch on YouTube/ })).toHaveAttribute('href', `https://www.youtube.com/watch?v=${ID}`);
    });

    it('says a removed or private video is no longer available, without a dead link', () => {
      render(<LessonVideoPlayer video={video()} />);
      fireEvent.click(screen.getByRole('button', { name: /Play video/ }));
      post(document.querySelector('iframe'), { event: 'onError', info: 100 });
      expect(screen.getByRole('alert')).toHaveTextContent(/no longer available/);
      expect(screen.queryByRole('link', { name: /Watch on YouTube/ })).toBeNull();
    });

    it('ignores messages from any other origin or window', () => {
      render(<LessonVideoPlayer video={video()} />);
      fireEvent.click(screen.getByRole('button', { name: /Play video/ }));
      const frame = document.querySelector('iframe');
      post(frame, { event: 'onError', info: 150 }, { origin: 'https://evil.example' });
      post(frame, { event: 'onError', info: 150 }, { source: window });
      post(frame, '<img src=x onerror=alert(1)>');
      expect(document.querySelector('iframe')).not.toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});
