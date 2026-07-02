import {createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import getDocumentURL from '@appManagers/utils/docs/getDocumentURL';
import {getReelsFeed, ReelItem} from './reelsFeed';

import './reelsView.scss';

/**
 * Full-screen, vertically-paged reels feed. Native CSS scroll-snap does the
 * TikTok-style paging; an IntersectionObserver decides which reel is on screen
 * and lazily wires that <video> to tweb's service-worker stream URL
 * (getDocumentURL -> 'stream/…'), playing the active one and pausing the rest.
 */
export default function ReelsView(props: {onExit: () => void}) {
  const [items, setItems] = createSignal<ReelItem[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [failed, setFailed] = createSignal(false);
  const [muted, setMuted] = createSignal(true);

  const videoEls = new Map<number, HTMLVideoElement>();
  let observer: IntersectionObserver;

  const activate = (video: HTMLVideoElement) => {
    if(!video.src) {
      const url = video.dataset.streamUrl;
      if(url) video.src = url;
    }
    video.muted = muted();
    video.play().catch(() => {});
  };

  const deactivate = (video: HTMLVideoElement) => {
    video.pause();
  };

  const registerVideo = (video: HTMLVideoElement, item: ReelItem, index: number) => {
    video.dataset.streamUrl = getDocumentURL(item.doc);
    video.dataset.index = '' + index;
    videoEls.set(index, video);
    // The feed array is set once and never mutated, so per-item teardown isn't
    // needed — the component-level onCleanup disconnects the observer and frees
    // every element.
    observer?.observe(video);
  };

  onMount(async() => {
    observer = new IntersectionObserver((entries) => {
      for(const entry of entries) {
        const video = entry.target as HTMLVideoElement;
        if(entry.isIntersecting && entry.intersectionRatio >= 0.6) activate(video);
        else deactivate(video);
      }
    }, {threshold: [0, 0.6, 1]});

    try {
      const feed = await getReelsFeed();
      setItems(feed);
      setFailed(feed.length === 0);
    } catch(e) {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  });

  onCleanup(() => {
    observer?.disconnect();
    videoEls.forEach((v) => {
      v.pause();
      v.removeAttribute('src');
      v.load();
    });
    videoEls.clear();
  });

  const toggleMute = () => {
    const next = !muted();
    setMuted(next);
    videoEls.forEach((v) => (v.muted = next));
  };

  return (
    <div class="svipe-reels">
      <div class="svipe-reels__topbar">
        <button class="svipe-reels__icon-btn" onClick={props.onExit} aria-label="Close">
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19 6.4L17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>
        </button>
        <span class="svipe-reels__title">Reels</span>
        <button class="svipe-reels__icon-btn" onClick={toggleMute} aria-label="Toggle sound">
          <Show
            when={muted()}
            fallback={<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z"/></svg>}
          >
            <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.6 3l2.9-2.9-1.4-1.4-2.9 2.9-2.9-2.9-1.4 1.4 2.9 2.9-2.9 2.9 1.4 1.4 2.9-2.9 2.9 2.9 1.4-1.4z"/></svg>
          </Show>
        </button>
      </div>

      <Show when={loading()}>
        <div class="svipe-reels__center">
          <div class="svipe-reels__spinner" />
        </div>
      </Show>

      <Show when={!loading() && failed()}>
        <div class="svipe-reels__center svipe-reels__empty">
          <p>Reels feed is empty right now.</p>
          <p class="svipe-reels__empty-sub">Make sure you are signed in — the feed streams videos over your Telegram session.</p>
        </div>
      </Show>

      <div class="svipe-reels__scroller">
        <For each={items()}>
          {(item, index) => (
            <section class="svipe-reels__item">
              <video
                class="svipe-reels__video"
                playsinline
                loop
                muted
                preload="none"
                ref={(el) => registerVideo(el, item, index())}
              />
            </section>
          )}
        </For>
      </div>
    </div>
  );
}
