import {createEffect, createSignal, For, onCleanup, onMount} from 'solid-js';
import {render} from 'solid-js/web';
import lottieLoader from '@lib/rlottie/lottieLoader';
import type RLottiePlayer from '@lib/rlottie/rlottiePlayer';
import mediaSizes from '@helpers/mediaSizes';
import overlayCounter from '@helpers/overlayCounter';
import pause from '@helpers/schedulers/pause';
import rootScope from '@lib/rootScope';
import appImManager, {APP_TABS} from '@lib/appImManager';
import appSidebarLeft from '@components/sidebarLeft';
import {AppSettingsTab, getEditProfileInitArgs} from '@components/solidJsTabs';
import {AppContactsTab, AppEditProfileTab} from '@components/solidJsTabs/tabs';
import {AvatarNew} from '@components/avatarNew';
import reelsController from '@components/svipeReels/reelsController';
import searchController from '@components/svipeSearch/searchController';
import profileController from '@components/svipeProfile/profileController';
import type {ProfileAction} from '@components/svipeProfile/profileView';

import './mobileTabBar.scss';

/**
 * Mobile bottom tab bar mirroring the Svipe Android app (MainTabsActivity):
 * Reels, Chats, Search, Settings, Profile — left to right. The icons ARE the
 * Android Lottie files (res/raw/tab_*.json, copied to public/assets/tgs), played
 * outline<->filled on select exactly like the native GlassTabView. Profile
 * shows the user's avatar, like Android.
 *
 * Visibility follows the Android rule exactly: the bar exists only on the five
 * root tab surfaces. Anything pushed on top — an open chat, a slider sub-tab
 * (Edit Profile, Archive…), the chat-list search, a seeded (search-grid) reels
 * viewer, any dark overlay — hides it.
 */
type TabId = 'reels' | 'chats' | 'search' | 'settings' | 'profile';

type Tab = {
  id: TabId;
  label: string;
  lottie?: string; // filename stem under assets/tgs/svipe_tab_<stem>.json
  svg?: string; // fallback path data
};

const ICON_SIZE = 30;

// RLottiePlayer.setColor treats a STRING as a css-custom-property NAME (its
// textColor path) — literal '#hex'/'rgba()' strings silently apply no tint at
// all, leaving the Android JSONs' raw black. Colors must be [r, g, b] arrays.
type Rgb = [number, number, number];
const hexToRgb = (hex: string): Rgb => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const primary = (getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#3390ec');
const ACTIVE_COLOR: Rgb = primary.startsWith('#') ? hexToRgb(primary) : [51, 144, 236];
const INACTIVE_COLOR: Rgb = [166, 166, 166]; // ≈ white @60% on the dark pill

const TABS: Tab[] = [
  {id: 'reels', label: 'Reels', lottie: 'reels', svg: 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm6 3.5v9l7-4.5-7-4.5z'},
  {id: 'chats', label: 'Chats', lottie: 'chats', svg: 'M4 4h16a2 2 0 012 2v10a2 2 0 01-2 2H8l-4 4V6a2 2 0 012-2z'},
  {id: 'search', label: 'Search', lottie: 'search', svg: 'M10 4a6 6 0 104.47 10.03l4.75 4.75 1.41-1.41-4.75-4.75A6 6 0 0010 4zm0 2a4 4 0 110 8 4 4 0 010-8z'},
  {id: 'settings', label: 'Settings', lottie: 'settings', svg: 'M12 8a4 4 0 100 8 4 4 0 000-8zm8.94 4a6.9 6.9 0 00-.14-1.36l2.03-1.58-2-3.46-2.39.96a7 7 0 00-2.35-1.36L15.7 2h-4l-.39 2.84a7 7 0 00-2.35 1.36L6.57 5.2l-2 3.46L6.6 10.2A6.9 6.9 0 006.46 12c0 .46.05.91.14 1.36L4.57 14.9l2 3.46 2.39-.96a7 7 0 002.35 1.36L11.7 22h4l.39-2.84a7 7 0 002.35-1.36l2.39.96 2-3.46-2.03-1.58c.09-.45.14-.9.14-1.36z'},
  {id: 'profile', label: 'Profile', svg: 'M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z'}
];

export default function MobileTabBar() {
  // Reels is the default surface (mirrors Android's POSITION_REELS landing).
  const [active, setActive] = createSignal<TabId>('reels');
  const [visible, setVisible] = createSignal(false);
  const players = new Map<TabId, RLottiePlayer>();
  let disposed = false;

  // Which of our roots currently owns the left slider (only Settings lives
  // there now), and where to return when a handed-off slider sub-tab closes.
  let sliderRootTab: 'settings' | undefined;
  let returnTo: 'profile' | undefined;

  const columnLeft = document.getElementById('column-left');
  let searchHost: HTMLElement | undefined;
  const searchHostEl = () =>
    searchHost ??= (document.getElementById('search-container')?.parentElement?.parentElement as HTMLElement) || undefined;
  const sliderDepth = () => ((appSidebarLeft as any).historyTabIds?.length as number) ?? 0;

  // The Android visibility rule, evaluated from actual UI state.
  const computeVisible = (): boolean => {
    if(overlayCounter.isOverlayActive) return false;
    const body = document.body.classList;
    if(body.contains('svipe-reels-open')) {
      // Seeded reels (from the grid) is a pushed screen — no bar (Android).
      return !body.contains('svipe-reels-seeded');
    }
    if(body.contains('svipe-search-open') || body.contains('svipe-profile-open')) return true;
    if(!body.contains('is-left-column-shown')) return false; // inside a chat
    if(columnLeft?.classList.contains('has-open-tabs')) {
      // Only our Settings ROOT keeps the bar; deeper tabs and every other
      // slider surface (Edit Profile, Archive, New Chat…) hide it.
      return sliderRootTab === 'settings' && sliderDepth() <= 1;
    }
    if(searchHostEl()?.classList.contains('is-search-active')) return false; // chat-list search
    return true;
  };

  const update = () => setVisible(computeVisible());

  const applyIconState = (player: RLottiePlayer, isActive: boolean) => {
    player.setColor(isActive ? ACTIVE_COLOR : INACTIVE_COLOR, true);
    const target = isActive ? (player.maxFrame || 6) : 0;
    if(player.curFrame === target) {
      // playToFrame no-ops on the same frame — re-tint the canvas in place.
      player.applyColorForAllContexts();
    } else {
      player.playToFrame({frame: target});
    }
  };

  const setupIcon = (container: HTMLElement, tab: Tab) => {
    if(tab.id === 'profile') {
      // Android shows the user's avatar in the Profile slot (GlassTabView.createAvatar).
      // Guarded: a failure here (e.g. myId not resolvable yet) must not kill
      // the whole bar render — the person-SVG fallback stays instead.
      try {
        const avatar = AvatarNew({peerId: rootScope.myId, size: 26, isDialog: false});
        avatar.readyThumbPromise?.then(() => {
          if(!disposed) container.classList.add('has-lottie');
        }).catch(() => {});
        container.append(avatar.node);
      } catch(e) {}
      return;
    }
    if(!tab.lottie) return;
    lottieLoader.loadAnimationFromURL({
      container,
      width: ICON_SIZE,
      height: ICON_SIZE,
      loop: false,
      autoplay: false
    }, `assets/tgs/svipe_tab_${tab.lottie}.json`).then((player) => {
      if(disposed) {
        player.remove?.();
        return;
      }
      players.set(tab.id, player);
      container.classList.add('has-lottie');
      applyIconState(player, active() === tab.id);
    }).catch(() => {/* keep the SVG fallback */});
  };

  // Animate every loaded icon when the active tab changes — and re-apply on
  // every re-show: while the bar is display:none the rlottie players are
  // paused/skipped, so tint/frame changes made then never hit the canvas
  // (icons were stuck black or on a stale active color).
  createEffect(() => {
    if(!visible()) return;
    const cur = active();
    players.forEach((player, id) => applyIconState(player, id === cur));
  });

  // What the highlight should fall back to when a surface on top goes away.
  const surfaceUnderneath = (): TabId =>
    reelsController.isOpen ? 'reels' :
      searchController.isOpen ? 'search' :
        profileController.isOpen ? 'profile' : 'chats';

  // Track tweb's own tab switches (opening/closing a chat) so the highlight
  // follows the chat surface when no svipe surface is open.
  const onTabChanging = (tabId: number) => {
    if(!reelsController.isOpen && !searchController.isOpen && !profileController.isOpen &&
      tabId === APP_TABS.CHATLIST && (active() === 'reels' || active() === 'chats')) {
      setActive('chats');
    }
    // selectTab runs before the body class flips — recompute after it settles.
    queueMicrotask(update);
  };
  appImManager.addEventListener('tab_changing', onTabChanging);

  const onOverlayChange = () => update();
  overlayCounter.addEventListener('change', onOverlayChange);

  // DOM state watchers: body classes (svipe surfaces / column switches), the
  // slider's has-open-tabs flag, and tab pushes/pops inside the slider.
  let bodyObserver: MutationObserver | undefined;
  let columnObserver: MutationObserver | undefined;
  let sliderObserver: MutationObserver | undefined;
  let hadOpenTabs = false;

  const onColumnMutate = () => {
    const has = !!columnLeft?.classList.contains('has-open-tabs');
    if(hadOpenTabs && !has) {
      // The slider stack fully closed.
      sliderRootTab = undefined;
      if(returnTo === 'profile') {
        returnTo = undefined;
        openProfileSurface(); // Android back-flow: sub-screen → profile
      } else if(active() === 'settings' || active() === 'profile') {
        setActive(surfaceUnderneath());
      }
    }
    hadOpenTabs = has;
    update();
  };

  onMount(() => {
    hadOpenTabs = !!columnLeft?.classList.contains('has-open-tabs');

    bodyObserver = new MutationObserver(update);
    bodyObserver.observe(document.body, {attributes: true, attributeFilter: ['class']});

    if(columnLeft) {
      columnObserver = new MutationObserver(onColumnMutate);
      columnObserver.observe(columnLeft, {attributes: true, attributeFilter: ['class']});

      const sliderEl = columnLeft.querySelector('.sidebar-slider');
      if(sliderEl) {
        // Fires on tab transitions (push/pop) and on is-search-active flips.
        sliderObserver = new MutationObserver(update);
        sliderObserver.observe(sliderEl, {subtree: true, childList: true, attributes: true, attributeFilter: ['class']});
      }
    }

    update();
  });

  onCleanup(() => {
    disposed = true;
    appImManager.removeEventListener('tab_changing', onTabChanging);
    overlayCounter.removeEventListener('change', onOverlayChange);
    bodyObserver?.disconnect();
    columnObserver?.disconnect();
    sliderObserver?.disconnect();
    players.forEach((player) => player.remove?.());
    players.clear();
  });

  const closeSvipeSurfaces = () => {
    if(reelsController.isOpen) reelsController.close();
    if(searchController.isOpen) searchController.close();
    if(profileController.isOpen) profileController.close();
  };

  const openChats = () => {
    returnTo = undefined;
    closeSvipeSurfaces();
    appSidebarLeft.closeEverythingInside();
    appImManager.selectTab(APP_TABS.CHATLIST);
    setActive('chats');
    update();
  };

  const openReels = (seedCode?: string) => {
    returnTo = undefined;
    // A seeded (search-grid) reels surface counts as open — replace it.
    if(reelsController.isOpen) reelsController.close();
    if(searchController.isOpen) searchController.close();
    if(profileController.isOpen) profileController.close();
    setActive('reels');
    reelsController.open({seedCode, onClose: () => setActive(surfaceUnderneath())});
    update();
  };

  const openSearch = () => {
    returnTo = undefined;
    if(reelsController.isOpen) {
      // A seeded reels surface may be covering the grid — closing it reveals it.
      reelsController.close();
    } else if(searchController.isOpen && active() === 'search') {
      searchController.scrollToTop();
      return;
    }
    if(profileController.isOpen) profileController.close();
    setActive('search');
    if(!searchController.isOpen) {
      searchController.open({onClose: () => setActive(surfaceUnderneath())});
    }
    update();
  };

  const openSettings = async() => {
    returnTo = undefined;
    closeSvipeSurfaces();
    appImManager.selectTab(APP_TABS.CHATLIST);
    if(appSidebarLeft.closeEverythingInside()) await pause(200);
    sliderRootTab = 'settings';
    appSidebarLeft.createTab(AppSettingsTab).open();
    setActive('settings');
    update();
  };

  // Profile action-row buttons hand off to left-slider tabs; when that stack
  // closes, onColumnMutate reopens the profile surface (Android back-flow).
  const onProfileAction = (action: ProfileAction) => {
    profileController.close(false, true); // silent: keep the Profile highlight
    appImManager.selectTab(APP_TABS.CHATLIST);
    returnTo = 'profile';
    if(action === 'settings') {
      appSidebarLeft.createTab(AppSettingsTab).open();
    } else if(action === 'contacts') {
      appSidebarLeft.createTab(AppContactsTab).open();
    } else {
      // 'set-photo' and 'edit-info' both live in Edit Profile on web.
      appSidebarLeft.createTab(AppEditProfileTab).open(getEditProfileInitArgs());
    }
    update();
  };

  const openProfileSurface = () => {
    setActive('profile');
    profileController.open({
      onClose: () => {
        setActive(surfaceUnderneath());
        update();
      },
      onAction: onProfileAction
    });
    update();
  };

  const openProfile = () => {
    returnTo = undefined;
    closeSvipeSurfaces();
    appSidebarLeft.closeEverythingInside();
    appImManager.selectTab(APP_TABS.CHATLIST);
    openProfileSurface();
  };

  // Reels opens on boot: always when a share deep-link (?svipeReel) is present
  // (even on desktop), and by default on mobile (Reels is the landing tab).
  // On desktop with no deep-link we stay on the normal chat UI.
  onMount(() => {
    if(reelsController.isOpen) return;
    const seedCode = new URLSearchParams(location.search).get('svipeReel') || undefined;
    if(seedCode || mediaSizes.isMobile) {
      openReels(seedCode);
    } else {
      setActive('chats');
    }
  });

  const onTabClick = (tab: Tab) => {
    switch(tab.id) {
      case 'reels':
        if(!(reelsController.isOpen && active() === 'reels')) openReels();
        break;
      case 'chats':
        openChats();
        break;
      case 'search':
        openSearch();
        break;
      case 'settings':
        if(active() !== 'settings') openSettings();
        break;
      case 'profile':
        if(!(profileController.isOpen && active() === 'profile')) openProfile();
        break;
    }
  };

  return (
    <nav class="svipe-tabbar" classList={{'svipe-tabbar--visible': visible()}}>
      <For each={TABS}>
        {(tab) => (
          <button
            class="svipe-tabbar__tab"
            classList={{'svipe-tabbar__tab--active': active() === tab.id}}
            onClick={() => onTabClick(tab)}
            aria-label={tab.label}
          >
            <span
              class="svipe-tabbar__icon"
              classList={{'svipe-tabbar__icon--profile': tab.id === 'profile'}}
              ref={(el) => setupIcon(el, tab)}
            >
              <svg class="svipe-tabbar__svg" viewBox="0 0 24 24" width={ICON_SIZE - 4} height={ICON_SIZE - 4}>
                <path fill="currentColor" d={tab.svg} />
              </svg>
            </span>
            <span class="svipe-tabbar__label">{tab.label}</span>
          </button>
        )}
      </For>
    </nav>
  );
}

/** Mount the bottom bar once, at IM bootstrap. Returns the Solid dispose fn. */
export function mountMobileTabBar() {
  const el = document.getElementById('mobile-tab-bar');
  if(!el) return;
  return render(() => <MobileTabBar />, el);
}
