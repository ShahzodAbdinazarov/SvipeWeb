import {createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import LazyLoadQueue from '@components/lazyLoadQueue';
import wrapVideo from '@components/wrappers/video';
import choosePhotoSize from '@appManagers/utils/photos/choosePhotoSize';
import {getMiddleware} from '@helpers/middleware';
import reelsController from '@components/svipeReels/reelsController';
import {DiscoverRef, ReelItem, resolveDiscoverRefsBatched} from '@components/svipeReels/reelsFeed';
import {svipeGetJson} from '@lib/svipe/api';

import './exploreGrid.scss';

/** A grid cell keeps both the raw backend ref (for seeding the continuation
 * feed) and its resolved Telegram message (for the thumbnail + instant play). */
type GridCell = {ref: DiscoverRef; item: ReelItem};

type DiscoverResponse = {items?: DiscoverRef[]; next_offset?: number | null};

const PAGE_LIMIT = 60;
const PULL_THRESHOLD = 72; // raw drag px; the puck moves at ~0.5 damping
const SKELETON = new Array(15).fill(0);

/**
 * Port of Android's SvipeExploreGrid: a 3-column, 2:3 discover grid fed by
 * /v1/discover, with shimmer skeleton, infinite scroll, pull-to-refresh and
 * cell-tap → seeded reels. The tree is persistent (searchController never
 * disposes it), so onMount runs exactly once — on the first tab open.
 */
export default function ExploreGrid(props: {
  onEngageSearch: () => void;
  registerScroller: (el: HTMLDivElement) => void;
}) {
  const [cells, setCells] = createSignal<GridCell[]>([]);
  const [pull, setPull] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);

  let scroller: HTMLDivElement;
  let sentinel: HTMLDivElement;
  let observer: IntersectionObserver;
  let nextOffset: number | null | undefined; // null = exhausted, undefined = first page not loaded
  let loadingMore = false;

  const lazyLoadQueue = new LazyLoadQueue();
  const middleware = getMiddleware().get(); // grid lives forever — never cleaned

  const fetchPage = async(offset: number, refresh?: boolean): Promise<{cells: GridCell[]; nextOffset: number | null}> => {
    const data = await svipeGetJson<DiscoverResponse>(
      `/v1/discover?limit=${PAGE_LIMIT}&offset=${offset}` + (refresh ? '&refresh=1' : ''));
    if(!data) throw new Error('svipe discover unavailable');

    const refs = (data.items || []).filter((ref) => !!ref.username);
    const resolved = await resolveDiscoverRefsBatched(refs);
    const out: GridCell[] = [];
    refs.forEach((ref, i) => {
      const item = resolved[i];
      // Android parity: only resolvable videos make it into the grid.
      if(item) out.push({ref, item});
    });
    return {cells: out, nextOffset: data.next_offset ?? null};
  };

  // IO doesn't re-fire while the sentinel stays visible across a content
  // change — re-observing forces a fresh intersection record.
  const recheckSentinel = () => {
    if(!observer || !sentinel) return;
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  };

  const maybeLoadMore = async() => {
    if(loadingMore || refreshing() || typeof(nextOffset) !== 'number') return;
    loadingMore = true;
    try {
      const page = await fetchPage(nextOffset);
      nextOffset = page.nextOffset;
      if(page.cells.length) setCells((prev) => [...prev, ...page.cells]);
    } catch(e) {
      // keep the current offset; the next sentinel hit retries
    } finally {
      loadingMore = false;
      recheckSentinel();
    }
  };

  const refresh = async() => {
    if(refreshing()) return;
    setRefreshing(true);
    try {
      const page = await fetchPage(0, true);
      // Atomic swap: the old grid stays on screen until this moment.
      setCells(page.cells);
      nextOffset = page.nextOffset;
      scroller.scrollTop = 0;
    } catch(e) {
      // keep the existing grid
    } finally {
      setRefreshing(false);
      recheckSentinel();
    }
  };

  // ---- pull-to-refresh (armed only when the scroller starts at the top) ----

  let touchStartY = 0;
  let pullArmed = false;

  const onTouchStart = (e: TouchEvent) => {
    if(scroller.scrollTop > 0 || refreshing()) return;
    pullArmed = true;
    touchStartY = e.touches[0].clientY;
    setDragging(true);
  };

  const onTouchMove = (e: TouchEvent) => {
    if(!pullArmed) return;
    const dy = e.touches[0].clientY - touchStartY;
    if(dy <= 0) {
      setPull(0);
      return;
    }
    if(scroller.scrollTop > 0) {
      pullArmed = false;
      setPull(0);
      return;
    }
    e.preventDefault(); // we own the gesture: no rubber-banding under the puck
    setPull(dy);
  };

  const onTouchEnd = () => {
    if(!pullArmed) return;
    pullArmed = false;
    const dy = pull();
    setDragging(false);
    setPull(0);
    if(dy >= PULL_THRESHOLD) refresh();
  };

  // Puck slides down from behind the search pill; pinned while refreshing.
  const puckY = () => -48 + (refreshing() ? 72 : Math.min(pull() * 0.5, 96));

  onMount(() => {
    props.registerScroller(scroller);

    observer = new IntersectionObserver((entries) => {
      if(entries.some((entry) => entry.isIntersecting)) maybeLoadMore();
    }, {root: scroller, rootMargin: '100% 0px'}); // prefetch ~2 rows early
    observer.observe(sentinel);

    scroller.addEventListener('touchstart', onTouchStart, {passive: true});
    scroller.addEventListener('touchmove', onTouchMove, {passive: false});
    scroller.addEventListener('touchend', onTouchEnd);
    scroller.addEventListener('touchcancel', onTouchEnd);

    // Lazy first load: the tree only mounts the first time the tab opens.
    fetchPage(0).then((page) => {
      setCells(page.cells);
      nextOffset = page.nextOffset;
      recheckSentinel();
    }).catch(() => {
      // skeleton stays; pull-to-refresh is the retry path
    });
  });

  onCleanup(() => {
    observer?.disconnect();
    scroller.removeEventListener('touchstart', onTouchStart);
    scroller.removeEventListener('touchmove', onTouchMove);
    scroller.removeEventListener('touchend', onTouchEnd);
    scroller.removeEventListener('touchcancel', onTouchEnd);
  });

  const wrapCell = async(el: HTMLElement, cell: GridCell) => {
    try {
      const wrapped = (await wrapVideo({
        doc: cell.item.doc,
        message: cell.item.message,
        container: el,
        boxWidth: 0,
        boxHeight: 0,
        lazyLoadQueue,
        middleware,
        onlyPreview: true,
        withoutPreloader: true,
        noPlayButton: true,
        photoSize: choosePhotoSize(cell.item.doc, 240, 240)
      })).thumb;

      [wrapped.images.thumb, wrapped.images.full].filter(Boolean).forEach((image) => {
        image.classList.add('svipe-explore__thumb');
      });
    } catch(e) {
      // cell keeps its shimmer background
    }
  };

  const openCell = (cell: GridCell) => {
    // Reels surface (z-4) stacks over the grid (z-3); the grid stays alive
    // underneath, and the tab bar owns its own highlight — so no onClose.
    reelsController.open({
      seedReel: cell.item,
      seed: {
        channelId: cell.ref.channel_id,
        messageId: cell.ref.message_id,
        topicId: cell.ref.topic_id ?? undefined
      },
      fromSearch: true
    });
  };

  return (
    <div class="svipe-explore" ref={scroller}>
      <button class="svipe-explore__search" onClick={() => props.onEngageSearch()}>
        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
        <span>Qidiruv</span>
      </button>

      <Show when={pull() > 0 || refreshing()}>
        <div
          class="svipe-explore__puck"
          classList={{'svipe-explore__puck--dragging': dragging()}}
          style={{transform: `translate(-50%, ${puckY()}px)`}}
        >
          <div class="svipe-explore__puck-spinner" />
        </div>
      </Show>

      <div class="svipe-explore__grid">
        <Show when={!cells().length}>
          <For each={SKELETON}>
            {() => <div class="svipe-explore__cell" />}
          </For>
        </Show>
        <For each={cells()}>
          {(cell) => (
            <div
              class="svipe-explore__cell"
              onClick={() => openCell(cell)}
              ref={(el) => wrapCell(el, cell)}
            />
          )}
        </For>
      </div>

      <div class="svipe-explore__sentinel" ref={sentinel} />
    </div>
  );
}
