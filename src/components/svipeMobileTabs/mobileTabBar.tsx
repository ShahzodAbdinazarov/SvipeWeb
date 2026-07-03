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
import {AppSettingsTab} from '@components/solidJsTabs';
import AppSharedMediaTab from '@components/sidebarRight/tabs/sharedMediaTab';
import {AvatarNew} from '@components/avatarNew';
import reelsController from '@components/svipeReels/reelsController';
import searchController from '@components/svipeSearch/searchController';

import './mobileTabBar.scss';

/**
 * Mobile bottom tab bar mirroring the Svipe Android app (MainTabsActivity):
 * Reels, Chats, Search, Settings, Profile — left to right. The icons ARE the
 * Android Lottie files (res/raw/tab_*.json, copied to public/assets/tgs), played
 * outline<->filled on select exactly like the native GlassTabView. A static SVG
 * sits behind each icon as a fallback until (or unless) the Lottie renders, so
 * the bar is never blank. Profile shows the user's avatar, like Android.
 */
type TabId = 'reels' | 'chats' | 'search' | 'settings' | 'profile';

type Tab = {
  id: TabId;
  label: string;
  lottie?: string; // filename stem under assets/tgs/svipe_tab_<stem>.json
  svg?: string; // fallback path data
};

const ICON_SIZE = 30;
const ACTIVE_COLOR = (getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#3390ec');
const INACTIVE_COLOR = 'rgba(255, 255, 255, 0.6)';

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
  // Hidden under any dark overlay: stories viewer, media viewer, popups —
  // they all share z-index 4 with the reels surface, but the bar is z-5.
  const [overlayHidden, setOverlayHidden] = createSignal(false);
  const players = new Map<TabId, RLottiePlayer>();
  let disposed = false;

  const applyIconState = (player: RLottiePlayer, isActive: boolean) => {
    player.setColor(isActive ? ACTIVE_COLOR : INACTIVE_COLOR, true);
    player.playToFrame({frame: isActive ? (player.maxFrame || 6) : 0});
  };

  const setupIcon = (container: HTMLElement, tab: Tab) => {
    if(tab.id === 'profile') {
      // Android shows the user's avatar in the Profile slot (GlassTabView.createAvatar).
      const avatar = AvatarNew({peerId: rootScope.myId, size: 26, isDialog: false});
      avatar.readyThumbPromise?.then(() => {
        if(!disposed) container.classList.add('has-lottie');
      }).catch(() => {});
      container.append(avatar.node);
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

  // Animate every loaded icon when the active tab changes.
  createEffect(() => {
    const cur = active();
    players.forEach((player, id) => applyIconState(player, id === cur));
  });

  // Track tweb's own tab switches (opening/closing a chat) so the highlight
  // follows the chat surface when no svipe surface is open.
  const onTabChanging = (tabId: number) => {
    if(reelsController.isOpen || searchController.isOpen) return;
    if(tabId === APP_TABS.CHATLIST && (active() === 'reels' || active() === 'chats')) setActive('chats');
  };
  appImManager.addEventListener('tab_changing', onTabChanging);

  const onOverlayChange = (isActive: boolean) => setOverlayHidden(isActive);
  overlayCounter.addEventListener('change', onOverlayChange);

  // Backing out of the Settings/Profile slider tabs doesn't fire any tab
  // event — watch the sidebar's has-open-tabs class instead.
  let sliderObserver: MutationObserver | undefined;
  onMount(() => {
    const columnLeft = document.getElementById('column-left');
    if(!columnLeft) return;
    sliderObserver = new MutationObserver(() => {
      if(columnLeft.classList.contains('has-open-tabs')) return;
      if(active() === 'settings' || active() === 'profile') {
        setActive(surfaceUnderneath());
      }
    });
    sliderObserver.observe(columnLeft, {attributes: true, attributeFilter: ['class']});
  });

  onCleanup(() => {
    disposed = true;
    appImManager.removeEventListener('tab_changing', onTabChanging);
    overlayCounter.removeEventListener('change', onOverlayChange);
    sliderObserver?.disconnect();
    players.forEach((player) => player.remove?.());
    players.clear();
  });

  // What the highlight should fall back to when a surface on top goes away.
  const surfaceUnderneath = (): TabId =>
    reelsController.isOpen ? 'reels' : searchController.isOpen ? 'search' : 'chats';

  const closeSvipeSurfaces = () => {
    if(reelsController.isOpen) reelsController.close();
    if(searchController.isOpen) searchController.close();
  };

  const openChats = () => {
    closeSvipeSurfaces();
    appSidebarLeft.closeEverythingInside();
    appImManager.selectTab(APP_TABS.CHATLIST);
    setActive('chats');
  };

  const openReels = (seedCode?: string) => {
    // A seeded (search-grid) reels surface counts as open — replace it.
    if(reelsController.isOpen) reelsController.close();
    if(searchController.isOpen) searchController.close();
    setActive('reels');
    reelsController.open({seedCode, onClose: () => setActive(surfaceUnderneath())});
  };

  const openSearch = () => {
    if(reelsController.isOpen) {
      // A seeded reels surface may be covering the grid — closing it reveals it.
      reelsController.close();
    } else if(searchController.isOpen && active() === 'search') {
      searchController.scrollToTop();
      return;
    }
    setActive('search');
    if(!searchController.isOpen) {
      searchController.open({onClose: () => setActive(surfaceUnderneath())});
    }
  };

  // Settings and Profile live in the left-column slider (like the hamburger
  // menu entries); the chat list must be the visible column first.
  const openLeftSliderTab = async(tab: TabId, openTab: () => void) => {
    closeSvipeSurfaces();
    appImManager.selectTab(APP_TABS.CHATLIST);
    if(appSidebarLeft.closeEverythingInside()) await pause(200);
    openTab();
    setActive(tab);
  };

  const openSettings = () => openLeftSliderTab('settings', () => {
    appSidebarLeft.createTab(AppSettingsTab).open();
  });

  const openProfile = () => openLeftSliderTab('profile', () => {
    // Android's Profile tab = own ProfileActivity (header + posts grid); the
    // closest web building block is the shared-media profile tab for self.
    AppSharedMediaTab.open(appSidebarLeft, rootScope.myId, false);
  });

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
        if(active() !== 'profile') openProfile();
        break;
    }
  };

  return (
    <nav class="svipe-tabbar" classList={{'svipe-tabbar--overlay-hidden': overlayHidden()}}>
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
