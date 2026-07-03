import {createEffect, createSignal, For, on, onCleanup, onMount, Show} from 'solid-js';
import type {Chat} from '@layer';
import getDocumentURL from '@appManagers/utils/docs/getDocumentURL';
import choosePhotoSize from '@appManagers/utils/photos/choosePhotoSize';
import {getMiddleware} from '@helpers/middleware';
import {copyTextToClipboard} from '@helpers/clipboard';
import rootScope from '@lib/rootScope';
import appImManager from '@lib/appImManager';
import wrapVideo from '@components/wrappers/video';
import wrapEmojiText from '@lib/richTextProcessor/wrapEmojiText';
import {AvatarNew} from '@components/avatarNew';
import PeerTitle from '@components/peerTitle';
import generateVerifiedIcon from '@components/generateVerifiedIcon';
import {toast} from '@components/toast';
import showReportAdPopup from '@components/popups/reportAd';
import {classifyWatch, sendSvipeEvent} from '@lib/svipe/events';
import searchController from '@components/svipeSearch/searchController';
import type {ReelItem} from './reelsFeed';
import ReelsCommentsSheet from './reelsCommentsSheet';

const MIN_SEEKBAR_DURATION_S = 15; // Android: seek bar only for clips ≥ 15s
const SEEK_DEAD_RIGHT_PX = 62; // Android: rightmost strip is dead (rail column)

function formatCount(n: number): string {
  if(n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if(n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return '' + n;
}

/**
 * One full-screen reel page: video + the Android ReelsActivity chrome — right
 * action rail (like / comment / share / more), bottom-left channel bar +
 * caption, seek bar, pause indicator, gestures (tap = pause, double-tap =
 * like + heart burst, long-press = peek, pinch = zoom) and recsys telemetry.
 */
export default function ReelPage(props: {
  item: ReelItem;
  index: number;
  active: () => boolean;
  muted: () => boolean;
  peek: boolean;
  setPeek: (v: boolean) => void;
  registerSection: (el: HTMLElement, index: number) => void;
  onBlockChannel: (item: ReelItem) => void;
  onExitToChannel: () => void;
}) {
  const item = props.item;
  const reactions = item.message.reactions;
  const [liked, setLiked] = createSignal(!!reactions?.results?.some((r) => r.chosen_order !== undefined));
  const [likeCount, setLikeCount] = createSignal(reactions?.results?.reduce((s, r) => s + r.count, 0) ?? 0);
  const [commentCount, setCommentCount] = createSignal((item.message.replies as any)?.replies ?? 0);
  const [following, setFollowing] = createSignal(true); // hidden until we know we're NOT subscribed
  const [verified, setVerified] = createSignal(false);
  const [captionExpanded, setCaptionExpanded] = createSignal(false);
  const [userPaused, setUserPaused] = createSignal(false);
  const [buffering, setBuffering] = createSignal(false);
  const [posterHidden, setPosterHidden] = createSignal(false);
  const [duration, setDuration] = createSignal(0);
  const [progress, setProgress] = createSignal(0);
  const [seeking, setSeeking] = createSignal(false);
  const [showComments, setShowComments] = createSignal(false);
  const [showMenu, setShowMenu] = createSignal(false);
  const [bursts, setBursts] = createSignal<{x: number; y: number; id: number}[]>([]);

  const commentsEnabled = !!(item.message.replies as any)?.pFlags?.comments;
  const shareCount = (item.message as any).forwards ?? 0;
  const caption = item.message.message || '';
  const shareUrl = item.shareUrl ||
    (item.username && item.serverMsgId ? `https://t.me/${item.username}/${item.serverMsgId}` : undefined);

  let video!: HTMLVideoElement;
  let mediaEl!: HTMLDivElement;
  let sectionEl!: HTMLElement;
  const middlewareHelper = getMiddleware();

  // The observer maps sections back to feed positions through dataset.index;
  // keep it fresh when items shift (e.g. a blocked channel's reels removed).
  createEffect(() => {
    if(sectionEl) sectionEl.dataset.index = '' + props.index;
  });

  // ---- watch telemetry (Android SvipeWatchEvent: clock excludes paused time) ----
  let wasActivated = false;
  let dwellStart = 0;
  let watchAccum = 0;
  let watchStart: number | undefined;

  const clockPause = () => {
    if(watchStart !== undefined) {
      watchAccum += Date.now() - watchStart;
      watchStart = undefined;
    }
  };

  const flushWatch = () => {
    if(!wasActivated) return;
    clockPause();
    const durationMs = video?.duration ? video.duration * 1000 : undefined;
    sendSvipeEvent(item, classifyWatch(watchAccum, durationMs), {
      watched_ms: watchAccum,
      ...(durationMs ? {video_duration_ms: Math.round(durationMs)} : {}),
      dwell_ms: Date.now() - dwellStart,
      feed_position: item.feedPosition
    });
    wasActivated = false;
    watchAccum = 0;
  };

  const activate = () => {
    if(!video.src) {
      const url = getDocumentURL(item.doc);
      if(url) video.src = url;
    }
    video.muted = props.muted();
    setUserPaused(false);
    video.play().catch(() => {});
    wasActivated = true;
    dwellStart = Date.now();
    watchAccum = 0;
    sendSvipeEvent(item, 'IMPRESSION', {feed_position: item.feedPosition});
  };

  const deactivate = () => {
    flushWatch();
    video?.pause();
    setShowComments(false);
    setShowMenu(false);
    setCaptionExpanded(false);
  };

  // `on` limits tracking to the active flag — activate() reads other signals
  // (muted) that must not re-trigger it (a re-run would double-send IMPRESSION).
  createEffect(on(() => props.active(), (isActive) => {
    if(!video) return;
    isActive ? activate() : deactivate();
  }));

  createEffect(() => {
    if(video) video.muted = props.muted();
  });

  // ---- actions ----

  const setLike = (want: boolean, skipSame = true) => {
    if(want === liked()) {
      if(skipSame) return;
    } else {
      setLiked(want);
      setLikeCount((c) => Math.max(0, c + (want ? 1 : -1)));
      // A Telegram ❤ reaction (mirrors Android's sendReaction); sendReaction
      // toggles off when the same reaction is already chosen, so only call it
      // on a real state change.
      rootScope.managers.appReactionsManager.sendReaction({
        message: item.message,
        reaction: {_: 'reactionEmoji', emoticon: '❤'}
      }).catch(() => {});
      sendSvipeEvent(item, want ? 'LIKE' : 'UNLIKE');
    }
  };

  const showHeartBurst = (x: number, y: number) => {
    const id = Date.now() + Math.random();
    setBursts((prev) => [...prev, {x, y, id}]);
    setTimeout(() => setBursts((prev) => prev.filter((b) => b.id !== id)), 750);
  };

  const share = () => {
    if(!shareUrl) return;
    sendSvipeEvent(item, 'SHARE');
    const text = 'watch reels on telegram with svipe';
    if(navigator.share) {
      navigator.share({url: shareUrl, text}).catch(() => {});
    } else {
      copyTextToClipboard(shareUrl);
      toast('Havola nusxalandi');
    }
  };

  const copyLink = () => {
    if(!shareUrl) return;
    copyTextToClipboard(shareUrl);
    toast('Havola nusxalandi');
  };

  const goToChannel = () => {
    props.onExitToChannel();
    // In seeded mode the explore grid (z-3) would still cover the chat.
    if(searchController.isOpen) searchController.close();
    appImManager.setInnerPeer({peerId: item.peerId, lastMsgId: item.mid});
  };

  const follow = () => {
    if(!item.chatId) return;
    setFollowing(true);
    rootScope.managers.appChatsManager.joinChannel(item.chatId).catch(() => setFollowing(false));
    sendSvipeEvent(item, 'FOLLOW');
  };

  const notInterested = () => {
    sendSvipeEvent(item, 'NOT_INTERESTED');
    toast('Bunday videolar kamroq ko\'rsatiladi');
  };

  const blockChannel = () => {
    sendSvipeEvent(item, 'BLOCK_CHANNEL');
    toast('Kanal bloklandi');
    props.onBlockChannel(item);
  };

  const report = () => {
    showReportAdPopup('message', (option, text) =>
      rootScope.managers.appMessagesManager.reportMessages(item.peerId, [item.mid], option, text) as any);
  };

  // ---- gestures: tap = play/pause, double-tap = like, long-press = peek,
  // two-finger pinch = zoom (chrome hidden while zoomed) ----

  const togglePlayPause = () => {
    if(!video) return;
    if(video.paused) {
      setUserPaused(false);
      video.play().catch(() => {});
    } else {
      setUserPaused(true);
      video.pause();
    }
  };

  let lpTimer: number | undefined;
  let lpFired = false;
  let singleTimer: number | undefined;
  let lastTap = 0;
  let downX = 0;
  let downY = 0;
  let moved = false;

  const cancelLp = () => {
    if(lpTimer !== undefined) {
      clearTimeout(lpTimer);
      lpTimer = undefined;
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if(e.pointerType === 'mouse' && e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
    moved = false;
    lpFired = false;
    cancelLp();
    lpTimer = window.setTimeout(() => {
      lpFired = true;
      props.setPeek(true);
    }, 450);
  };

  const onPointerMove = (e: PointerEvent) => {
    if(Math.hypot(e.clientX - downX, e.clientY - downY) > 12) {
      moved = true;
      cancelLp();
      if(lpFired) {
        // keep peek while the finger is held even if it drifts
      }
    }
  };

  const endGesture = () => {
    cancelLp();
    if(lpFired) {
      lpFired = false;
      props.setPeek(false);
      return true;
    }
    return false;
  };

  const onPointerUp = (e: PointerEvent) => {
    if(endGesture() || moved || pinching) return;
    const now = Date.now();
    if(now - lastTap < 300) {
      lastTap = 0;
      if(singleTimer !== undefined) {
        clearTimeout(singleTimer);
        singleTimer = undefined;
      }
      // Double-tap always likes, never unlikes; a repeat just replays the burst.
      showHeartBurst(e.clientX, e.clientY);
      setLike(true);
    } else {
      lastTap = now;
      singleTimer = window.setTimeout(() => {
        singleTimer = undefined;
        togglePlayPause();
      }, 280);
    }
  };

  const onPointerCancel = () => {
    moved = true;
    endGesture();
  };

  // Pinch zoom: scale 1–3 on the live video, chrome hidden while zoomed,
  // springs back on release (Android: 220ms).
  let pinching = false;
  let pinchStartDist = 0;
  let pinchStartMid = {x: 0, y: 0};

  const touchDist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const touchMid = (t: TouchList) => ({x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2});

  const onTouchStart = (e: TouchEvent) => {
    if(e.touches.length === 2) {
      pinching = true;
      cancelLp();
      pinchStartDist = touchDist(e.touches);
      pinchStartMid = touchMid(e.touches);
      video.style.transition = 'none';
      props.setPeek(true);
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    if(!pinching || e.touches.length !== 2) return;
    e.preventDefault();
    const scale = Math.min(3, Math.max(1, touchDist(e.touches) / pinchStartDist));
    const mid = touchMid(e.touches);
    video.style.transform =
      `translate(${mid.x - pinchStartMid.x}px, ${mid.y - pinchStartMid.y}px) scale(${scale})`;
  };

  const onTouchEnd = (e: TouchEvent) => {
    if(pinching && e.touches.length < 2) {
      pinching = false;
      video.style.transition = 'transform .22s cubic-bezier(.25,.1,.25,1)';
      video.style.transform = '';
      props.setPeek(false);
      setTimeout(() => video && (video.style.transition = ''), 240);
    }
  };

  // ---- seek bar ----

  const seekTo = (clientX: number, commit: boolean) => {
    const rect = mediaEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    setProgress(ratio);
    if(commit && video?.duration) video.currentTime = ratio * video.duration;
  };

  const onSeekDown = (e: PointerEvent) => {
    const rect = mediaEl.getBoundingClientRect();
    if(e.clientX > rect.right - SEEK_DEAD_RIGHT_PX) return;
    e.stopPropagation();
    setSeeking(true);
    seekTo(e.clientX, false);
    const move = (ev: PointerEvent) => seekTo(ev.clientX, false);
    const up = (ev: PointerEvent) => {
      seekTo(ev.clientX, true);
      setSeeking(false);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  // ---- mount: poster thumb, video events, channel info ----

  onMount(async() => {
    // Pinch needs preventDefault on touchmove — Solid's delegated JSX touch
    // handlers can be passive, so these are attached manually.
    mediaEl.addEventListener('touchstart', onTouchStart, {passive: true});
    mediaEl.addEventListener('touchmove', onTouchMove, {passive: false});
    mediaEl.addEventListener('touchend', onTouchEnd);
    mediaEl.addEventListener('touchcancel', onTouchEnd);

    // Cover thumbnail (Android: video thumb visible until the first frame).
    const posterContainer = mediaEl.querySelector('.svipe-reels__poster') as HTMLElement;
    if(posterContainer) {
      const size = choosePhotoSize(item.doc, 400, 400);
      wrapVideo({
        doc: item.doc,
        message: item.message,
        container: posterContainer,
        boxWidth: 0,
        boxHeight: 0,
        middleware: middlewareHelper.get(),
        onlyPreview: true,
        withoutPreloader: true,
        noPlayButton: true,
        photoSize: size as any
      }).catch(() => {});
    }

    video.addEventListener('play', () => {
      if(props.active()) watchStart = Date.now();
    });
    video.addEventListener('pause', clockPause);
    video.addEventListener('playing', () => {
      setBuffering(false);
      setPosterHidden(true);
    });
    video.addEventListener('waiting', () => setBuffering(true));
    video.addEventListener('durationchange', () => setDuration(video.duration || 0));
    video.addEventListener('timeupdate', () => {
      if(!seeking() && video.duration) setProgress(video.currentTime / video.duration);
    });

    // Verified badge + follow state need the chat object.
    if(item.chatId) {
      try {
        const chat = await rootScope.managers.appChatsManager.getChat(item.chatId) as Chat.channel;
        if(chat) {
          setVerified(!!chat.pFlags?.verified);
          setFollowing(!chat.pFlags?.left);
        }
      } catch(e) {}
    }
  });

  onCleanup(() => {
    flushWatch();
    cancelLp();
    if(singleTimer !== undefined) clearTimeout(singleTimer);
    middlewareHelper.destroy();
    if(video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  });

  const renderAvatar = () => AvatarNew({peerId: item.peerId, size: 36, isDialog: false}).node;
  const renderTitle = () => new PeerTitle({peerId: item.peerId, dialog: false}).element;

  return (
    <section
      class="svipe-reels__item"
      ref={(el) => {
        sectionEl = el;
        props.registerSection(el, props.index);
      }}
    >
      <div
        class="svipe-reels__media"
        ref={mediaEl}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <video class="svipe-reels__video" playsinline loop muted preload="none" ref={video} />
        <div class="svipe-reels__poster" classList={{'svipe-reels__poster--hidden': posterHidden()}} />
        <Show when={props.active() && buffering() && !userPaused()}>
          <div class="svipe-reels__buffer"><div class="svipe-reels__spinner" /></div>
        </Show>
        <Show when={userPaused()}>
          <div class="svipe-reels__pause-badge">
            <svg viewBox="0 0 24 24" width="30" height="30"><path fill="#fff" d="M8 5v14l11-7z"/></svg>
          </div>
        </Show>
        <For each={bursts()}>
          {(b) => (
            <div class="svipe-reels__burst" style={{left: b.x + 'px', top: b.y + 'px'}}>
              <svg viewBox="0 0 24 24"><path fill="#FF2E38" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            </div>
          )}
        </For>
      </div>

      <div class="svipe-reels__shade" classList={{'svipe-reels__chrome--hidden': props.peek}} />

      {/* Right action rail (Android: 56dp column, like/comment/share/more) */}
      <div class="svipe-reels__rail" classList={{'svipe-reels__chrome--hidden': props.peek}}>
        <button class="svipe-reels__rail-btn" onClick={() => setLike(!liked(), false)} aria-label="Like">
          <svg viewBox="0 0 24 24" width="32" height="32">
            <Show
              when={liked()}
              fallback={<path fill="#fff" d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/>}
            >
              <path fill="#FF2E38" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
            </Show>
          </svg>
        </button>
        <span class="svipe-reels__rail-label">{likeCount() > 0 ? formatCount(likeCount()) : 'Like'}</span>

        <button
          class="svipe-reels__rail-btn"
          classList={{'svipe-reels__rail-btn--dim': !commentsEnabled && commentCount() === 0}}
          onClick={() => commentsEnabled && setShowComments(true)}
          aria-label="Comments"
        >
          <svg viewBox="0 0 24 24" width="30" height="30"><path fill="#fff" d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2zm0 14H5.17L4 17.17V4h16v12z"/></svg>
        </button>
        <span
          class="svipe-reels__rail-label"
          classList={{'svipe-reels__rail-label--dim': !commentsEnabled && commentCount() === 0}}
        >{commentCount() > 0 ? formatCount(commentCount()) : 'Izoh'}</span>

        <button class="svipe-reels__rail-btn" onClick={share} aria-label="Share">
          <svg viewBox="0 0 24 24" width="30" height="30"><path fill="#fff" d="M14 9V5l7 7-7 7v-4.1c-5 0-8.5 1.6-11 5.1 1-5 4-10 11-11z"/></svg>
        </button>
        <span class="svipe-reels__rail-label">{shareCount > 0 ? formatCount(shareCount) : 'Ulashish'}</span>

        <button class="svipe-reels__rail-btn" onClick={() => setShowMenu(true)} aria-label="More">
          <svg viewBox="0 0 24 24" width="28" height="28"><path fill="#fff" d="M12 8a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z"/></svg>
        </button>
      </div>

      {/* Bottom-left: channel bar + caption (Android bottomBox) */}
      <div class="svipe-reels__meta" classList={{'svipe-reels__chrome--hidden': props.peek}}>
        <div class="svipe-reels__channel">
          <span class="svipe-reels__channel-avatar" onClick={goToChannel}>{renderAvatar()}</span>
          <span class="svipe-reels__channel-title" onClick={goToChannel}>
            {renderTitle()}
            <Show when={verified()}><span class="svipe-reels__verified">{generateVerifiedIcon()}</span></Show>
          </span>
          <Show when={!following() && item.chatId}>
            <button class="svipe-reels__follow" onClick={follow}>Obuna</button>
          </Show>
        </div>
        <Show when={caption}>
          <div
            class="svipe-reels__caption"
            classList={{'svipe-reels__caption--expanded': captionExpanded()}}
            onClick={() => setCaptionExpanded(!captionExpanded())}
          >{wrapEmojiText(caption)}</div>
        </Show>
      </div>

      <Show when={duration() >= MIN_SEEKBAR_DURATION_S}>
        <div
          class="svipe-reels__seek"
          classList={{
            'svipe-reels__seek--dragging': seeking(),
            'svipe-reels__chrome--hidden': props.peek
          }}
          onPointerDown={onSeekDown}
        >
          <div class="svipe-reels__seek-track">
            <div class="svipe-reels__seek-played" style={{width: (progress() * 100) + '%'}} />
            <div class="svipe-reels__seek-thumb" style={{left: (progress() * 100) + '%'}} />
          </div>
        </div>
      </Show>

      <Show when={showMenu()}>
        <div class="svipe-reels__menu-backdrop" onClick={() => setShowMenu(false)}>
          <div class="svipe-reels__menu" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => {setShowMenu(false); share();}}>Ulashish</button>
            <button onClick={() => {setShowMenu(false); copyLink();}}>Havolani nusxalash</button>
            <button onClick={() => {setShowMenu(false); goToChannel();}}>Kanalga o'tish</button>
            <button onClick={() => {setShowMenu(false); notInterested();}}>Qiziq emas</button>
            <button onClick={() => {setShowMenu(false); blockChannel();}}>Kanalni bloklash</button>
            <button class="svipe-reels__menu-danger" onClick={() => {setShowMenu(false); report();}}>Shikoyat</button>
          </div>
        </div>
      </Show>

      <Show when={showComments()}>
        <ReelsCommentsSheet
          item={item}
          count={commentCount()}
          onCountChange={setCommentCount}
          onClose={() => setShowComments(false)}
        />
      </Show>
    </section>
  );
}
