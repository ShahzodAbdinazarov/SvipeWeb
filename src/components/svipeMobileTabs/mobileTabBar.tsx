import {createSignal, For, onCleanup} from 'solid-js';
import {render} from 'solid-js/web';
import appImManager, {APP_TABS} from '@lib/appImManager';
import reelsController from '@components/svipeReels/reelsController';

import './mobileTabBar.scss';

/**
 * Mobile bottom tab bar mirroring the Svipe Android app: Reels, Chats, Search,
 * Settings, Profile (left-to-right). v1 wires only Reels and Chats; the other
 * three are visible but disabled until their web surfaces exist.
 */
type TabId = 'reels' | 'chats' | 'search' | 'settings' | 'profile';

type Tab = {
  id: TabId;
  label: string;
  icon: () => any;
  enabled: boolean;
};

const icon = (path: string) => () => (
  <svg viewBox="0 0 24 24" width="26" height="26"><path fill="currentColor" d={path} /></svg>
);

const TABS: Tab[] = [
  {
    id: 'reels',
    label: 'Reels',
    enabled: true,
    icon: icon('M4 4h16a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V6a2 2 0 012-2zm6 3.5v9l7-4.5-7-4.5z')
  },
  {
    id: 'chats',
    label: 'Chats',
    enabled: true,
    icon: icon('M4 4h16a2 2 0 012 2v10a2 2 0 01-2 2H8l-4 4V6a2 2 0 012-2z')
  },
  {
    id: 'search',
    label: 'Search',
    enabled: false,
    icon: icon('M10 4a6 6 0 104.47 10.03l4.75 4.75 1.41-1.41-4.75-4.75A6 6 0 0010 4zm0 2a4 4 0 110 8 4 4 0 010-8z')
  },
  {
    id: 'settings',
    label: 'Settings',
    enabled: false,
    icon: icon('M12 8a4 4 0 100 8 4 4 0 000-8zm8.94 4a6.9 6.9 0 00-.14-1.36l2.03-1.58-2-3.46-2.39.96a7 7 0 00-2.35-1.36L15.7 2h-4l-.39 2.84a7 7 0 00-2.35 1.36L6.57 5.2l-2 3.46L6.6 10.2A6.9 6.9 0 006.46 12c0 .46.05.91.14 1.36L4.57 14.9l2 3.46 2.39-.96a7 7 0 002.35 1.36L11.7 22h4l.39-2.84a7 7 0 002.35-1.36l2.39.96 2-3.46-2.03-1.58c.09-.45.14-.9.14-1.36z')
  },
  {
    id: 'profile',
    label: 'Profile',
    enabled: false,
    icon: icon('M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z')
  }
];

export default function MobileTabBar() {
  const [active, setActive] = createSignal<TabId>('chats');

  // Keep the active tab in sync when tweb switches its own tabs (e.g. opening a
  // chat and coming back), so the bar highlight tracks the chat surface.
  const onTabChanging = (tabId: number) => {
    if(reelsController.isOpen) return;
    if(tabId === APP_TABS.CHATLIST) setActive('chats');
  };
  appImManager.addEventListener('tab_changing', onTabChanging);
  onCleanup(() => appImManager.removeEventListener('tab_changing', onTabChanging));

  const openChats = () => {
    if(reelsController.isOpen) reelsController.close();
    appImManager.selectTab(APP_TABS.CHATLIST);
    setActive('chats');
  };

  const openReels = () => {
    setActive('reels');
    reelsController.open(() => {
      // On close, fall back to whatever chat surface is showing.
      setActive('chats');
    });
  };

  const onTabClick = (tab: Tab) => {
    if(!tab.enabled) return;
    if(tab.id === 'reels') {
      if(!reelsController.isOpen) openReels();
      return;
    }
    if(tab.id === 'chats') {
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
            <span class="svipe-tabbar__icon">{tab.icon()}</span>
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
