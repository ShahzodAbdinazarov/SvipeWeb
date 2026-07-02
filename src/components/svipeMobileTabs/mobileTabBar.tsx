import {createEffect, createSignal, For, onCleanup, onMount} from 'solid-js';
import {render} from 'solid-js/web';
import lottieLoader from '@lib/rlottie/lottieLoader';
import type RLottiePlayer from '@lib/rlottie/rlottiePlayer';
import mediaSizes from '@helpers/mediaSizes';
import appImManager, {APP_TABS} from '@lib/appImManager';
import reelsController from '@components/svipeReels/reelsController';

import './mobileTabBar.scss';

/**
 * Mobile bottom tab bar mirroring the Svipe Android app (MainTabsActivity):
 * Reels, Chats, Search, Settings, Profile — left to right. The icons ARE the
 * Android Lottie files (res/raw/tab_*.json, copied to public/assets/tgs), played
 * outline<->filled on select exactly like the native GlassTabView. A static SVG
 * sits behind each icon as a fallback until (or unless) the Lottie renders, so
 * the bar is never blank. v1 wires Reels + Chats; Search/Settings/Profile are
 * visible-but-disabled until their web surfaces exist.
 */
type TabId = 'reels' | 'chats' | 'search' | 'settings' | 'profile';

type Tab = {
  id: TabId;
  label: string;
  enabled: boolean;
  lottie?: string; // filename stem under assets/tgs/svipe_tab_<stem>.json
  svg: string; // fallback path data
};

const ICON_SIZE = 30;
const ACTIVE_COLOR = (getComputedStyle(document.documentElement).getPropertyValue('--primary-color').trim() || '#3390ec');
const INACTIVE_COLOR = 'rgba(255, 255, 255, 0.6)';

const TABS: Tab[] = [
  {id: 'reels', label: 'Reels', enabled: true, lottie: 'reels', svg: 'M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm6 3.5v9l7-4.5-7-4.5z'},
  {id: 'chats', label: 'Chats', enabled: true, lottie: 'chats', svg: 'M4 4h16a2 2 0 012 2v10a2 2 0 01-2 2H8l-4 4V6a2 2 0 012-2z'},
  {id: 'search', label: 'Search', enabled: false, lottie: 'search', svg: 'M10 4a6 6 0 104.47 10.03l4.75 4.75 1.41-1.41-4.75-4.75A6 6 0 0010 4zm0 2a4 4 0 110 8 4 4 0 010-8z'},
  {id: 'settings', label: 'Settings', enabled: false, lottie: 'settings', svg: 'M12 8a4 4 0 100 8 4 4 0 000-8zm8.94 4a6.9 6.9 0 00-.14-1.36l2.03-1.58-2-3.46-2.39.96a7 7 0 00-2.35-1.36L15.7 2h-4l-.39 2.84a7 7 0 00-2.35 1.36L6.57 5.2l-2 3.46L6.6 10.2A6.9 6.9 0 006.46 12c0 .46.05.91.14 1.36L4.57 14.9l2 3.46 2.39-.96a7 7 0 002.35 1.36L11.7 22h4l.39-2.84a7 7 0 002.35-1.36l2.39.96 2-3.46-2.03-1.58c.09-.45.14-.9.14-1.36z'},
  {id: 'profile', label: 'Profile', enabled: false, svg: 'M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z'}
];

export default function MobileTabBar() {
  // Reels is the default surface (mirrors Android's POSITION_REELS landing).
  const [active, setActive] = createSignal<TabId>('reels');
  const players = new Map<TabId, RLottiePlayer>();
  let disposed = false;

  const applyIconState = (player: RLottiePlayer, isActive: boolean) => {
    player.setColor(isActive ? ACTIVE_COLOR : INACTIVE_COLOR, true);
    player.playToFrame({frame: isActive ? (player.maxFrame || 6) : 0});
  };

  const setupIcon = (container: HTMLElement, tab: Tab) => {
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
  // follows the chat surface when reels isn't open.
  const onTabChanging = (tabId: number) => {
    if(reelsController.isOpen) return;
    if(tabId === APP_TABS.CHATLIST) setActive('chats');
  };
  appImManager.addEventListener('tab_changing', onTabChanging);

  onCleanup(() => {
    disposed = true;
    appImManager.removeEventListener('tab_changing', onTabChanging);
    players.forEach((player) => player.remove?.());
    players.clear();
  });

  const openChats = () => {
    if(reelsController.isOpen) reelsController.close();
    appImManager.selectTab(APP_TABS.CHATLIST);
    setActive('chats');
  };

  const openReels = (seedCode?: string) => {
    setActive('reels');
    reelsController.open({seedCode, onClose: () => setActive('chats')});
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
    if(!tab.enabled) return;
    if(tab.id === 'reels') {
      if(!reelsController.isOpen) openReels();
    } else if(tab.id === 'chats') {
      openChats();
    }
  };

  return (
    <nav class="svipe-tabbar">
      <For each={TABS}>
        {(tab) => (
          <button
            class="svipe-tabbar__tab"
            classList={{
              'svipe-tabbar__tab--active': active() === tab.id,
              'svipe-tabbar__tab--disabled': !tab.enabled
            }}
            onClick={() => onTabClick(tab)}
            aria-label={tab.label}
            aria-disabled={!tab.enabled}
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
