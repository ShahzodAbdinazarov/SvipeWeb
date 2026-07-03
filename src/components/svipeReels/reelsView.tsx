import {createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import mediaSizes from '@helpers/mediaSizes';
import {FeedSeed, getReelsFeed, getSeedReel, loadMoreReels, ReelItem} from './reelsFeed';
import ReelPage from './reelPage';

import './reelsView.scss';

const PEEK_BODY_CLASS = 'svipe-reels-peek';

/**
 * Full-screen, vertically-paged reels feed. Native CSS scroll-snap does the
 * TikTok-style paging; an IntersectionObserver decides which reel is on screen
 * and each page wires its <video> to tweb's service-worker stream URL. All
 * per-reel chrome and actions live in ReelPage (ported from Android's
 * ReelsActivity); this component owns the feed, the active index, the global
 * mute state (web-only, browsers block unmuted autoplay) and the seeded-mode
 * back button.
 */
export default function ReelsView(props: {
  seedCode?: string;
  seedReel?: ReelItem;
  seed?: FeedSeed;
  fromSearch?: boolean;
  onExit: () => void;
}) {
  const [items, setItems] = createSignal<ReelItem[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [failed, setFailed] = createSignal(false);
  const [muted, setMuted] = createSignal(true);
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [peek, setPeekRaw] = createSignal(false);

  let observer: IntersectionObserver;
  let loadingMore = false;

  const keyOf = (r: ReelItem) => r.peerId + '_' + r.mid;

  const appendUnique = (more: ReelItem[]) => {
    setItems((prev) => {
      const seen = new Set(prev.map(keyOf));
      return [...prev, ...more.filter((r) => !seen.has(keyOf(r)))];
    });
  };

  // Grow the feed as the viewer nears the end (backend cursor pagination).
  const maybeLoadMore = async(index: number) => {
    if(loadingMore || index < items().length - 4) return;
    loadingMore = true;
    try {
      const more = await loadMoreReels();
      if(more.length) appendUnique(more);
    } finally {
      loadingMore = false;
    }
  };

  const setPeek = (v: boolean) => {
    setPeekRaw(v);
    // The tab bar (outside this tree) hides through this body class.
    document.body.classList.toggle(PEEK_BODY_CLASS, v);
  };

  const registerSection = (el: HTMLElement, index: number) => {
    el.dataset.index = '' + index;
    observer?.observe(el);
  };

  onMount(async() => {
    observer = new IntersectionObserver((entries) => {
      for(const entry of entries) {
        if(entry.isIntersecting && entry.intersectionRatio >= 0.6) {
          const index = Number((entry.target as HTMLElement).dataset.index || 0);
          setActiveIndex(index);
          maybeLoadMore(index);
        }
      }
    }, {threshold: [0.6]});

    try {
      // A seeded reel (explore-grid tap or share deep-link) is shown at index 0
      // instantly; the backend continuation feed loads underneath it.
      const seed = props.seedReel || (props.seedCode ? await getSeedReel(props.seedCode) : undefined);
      if(seed) {
        setItems([seed]);
        setLoading(false);
      }
      const feedSeed = props.seed ||
        (seed?.channelId && seed.serverMsgId ?
          {channelId: seed.channelId, messageId: seed.serverMsgId, topicId: seed.topicId} :
          undefined);
      const feed = await getReelsFeed(feedSeed);
      if(seed) {
        appendUnique(feed);
      } else {
        setItems(feed);
      }
      setFailed(items().length === 0);
    } catch(e) {
      setFailed(items().length === 0);
    } finally {
      setLoading(false);
    }
  });

  onCleanup(() => {
    observer?.disconnect();
    document.body.classList.remove(PEEK_BODY_CLASS);
  });

  const toggleMute = () => setMuted(!muted());

  // Blocking a channel instantly removes all of its reels (Android parity;
  // the BLOCK_CHANNEL event is sent by the page).
  const onBlockChannel = (blocked: ReelItem) => {
    setItems((prev) => prev.filter((r) => r.peerId !== blocked.peerId));
    if(!items().length) setFailed(true);
  };

  return (
    <div class="svipe-reels">
      <div class="svipe-reels__top" classList={{'svipe-reels__chrome--hidden': peek()}}>
        {/* Back arrow only in seeded (search) mode — Android parity. The main
            reels tab has no X: the bottom tab bar is the exit. Desktop (no tab
            bar) keeps the arrow so a deep-linked viewer can leave. */}
        <Show when={props.fromSearch || !mediaSizes.isMobile} fallback={<span />}>
          <button class="svipe-reels__icon-btn" onClick={props.onExit} aria-label="Back">
            <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
        </Show>
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
            <ReelPage
              item={item}
              index={index()}
              active={() => activeIndex() === index()}
              muted={muted}
              peek={peek()}
              setPeek={setPeek}
              registerSection={registerSection}
              onBlockChannel={onBlockChannel}
              onExitToChannel={props.onExit}
            />
          )}
        </For>
      </div>
    </div>
  );
}
