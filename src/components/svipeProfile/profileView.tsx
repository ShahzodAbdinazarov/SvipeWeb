import {createSignal, onCleanup, onMount, Show} from 'solid-js';
import type {User, UserFull} from '@layer';
import rootScope from '@lib/rootScope';
import Scrollable from '@components/scrollable';
import ListenerSetter from '@helpers/listenerSetter';
import {copyTextToClipboard} from '@helpers/clipboard';
import {formatPhoneNumber} from '@helpers/formatPhoneNumber';
import {getFirstChild} from '@solid-primitives/refs';
import {AvatarNew} from '@components/avatarNew';
import PeerTitle from '@components/peerTitle';
import {toast} from '@components/toast';
import {StoriesProfileList} from '@components/stories/profileList';

import './profileView.scss';

export type ProfileAction = 'set-photo' | 'edit-info' | 'settings' | 'contacts';

const ACTIONS: {action: ProfileAction; label: string; svg: string}[] = [
  {action: 'set-photo', label: 'Set Photo', svg: 'M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM9 3L7.17 5H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V7a2 2 0 00-2-2h-3.17L15 3H9zm3 15a5 5 0 110-10 5 5 0 010 10z'},
  {action: 'edit-info', label: 'Edit Info', svg: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z'},
  {action: 'settings', label: 'Settings', svg: 'M12 8a4 4 0 100 8 4 4 0 000-8zm8.94 4a6.9 6.9 0 00-.14-1.36l2.03-1.58-2-3.46-2.39.96a7 7 0 00-2.35-1.36L15.7 2h-4l-.39 2.84a7 7 0 00-2.35 1.36L6.57 5.2l-2 3.46L6.6 10.2A6.9 6.9 0 006.46 12c0 .46.05.91.14 1.36L4.57 14.9l2 3.46 2.39-.96a7 7 0 002.35 1.36L11.7 22h4l.39-2.84a7 7 0 002.35-1.36l2.39.96 2-3.46-2.03-1.58c.09-.45.14-.9.14-1.36z'},
  {action: 'contacts', label: 'Contacts', svg: 'M12 12a5 5 0 100-10 5 5 0 000 10zm0 2c-4.42 0-8 2.24-8 5v1h16v-1c0-2.76-3.58-5-8-5z'}
];

/**
 * Own-profile page, ported from Android's ProfileActivity my_profile mode:
 * expandable-ish header (avatar, name, "online"), a 4-button actions row
 * (Set Photo / Edit Info / Settings / Contacts), the info card (phone / bio /
 * username) and the Posts (pinned stories) grid. Android also shows Archived
 * Posts / Gifts tabs and an "Add a post" pill — story creation doesn't exist
 * on web K, so those are omitted.
 */
export default function ProfileView(props: {onAction: (action: ProfileAction) => void}) {
  const myId = rootScope.myId;
  const [phone, setPhone] = createSignal<string>();
  const [bio, setBio] = createSignal<string>();
  const [username, setUsername] = createSignal<string>();
  const [postsCount, setPostsCount] = createSignal<number | undefined>(undefined);

  let rootEl!: HTMLDivElement;
  let postsEl!: HTMLDivElement;
  const listenerSetter = new ListenerSetter();

  const copyRow = (value: string) => {
    copyTextToClipboard(value);
    toast('Nusxalandi');
  };

  onMount(async() => {
    // The whole page scrolls as one column (Android's profile list view).
    // The already-rendered div is passed as Scrollable's container — passing
    // it as `el` would re-parent the children and orphan Solid's <Show>
    // anchors, scattering late-rendered nodes (the info card) over the page.
    const scrollable = new Scrollable(undefined, 'SVIPE-PROFILE', 300, undefined, rootEl);

    const {render: storiesList, actions} = StoriesProfileList({
      peerId: myId,
      pinned: true,
      scrollable,
      listenerSetter,
      onCountChange: (count) => setPostsCount(count),
      onReady: () => {
        postsEl.append(getFirstChild(storiesList, (v) => v instanceof Element) as Element);
      }
    });
    actions.load();

    try {
      const [user, full] = await Promise.all([
        rootScope.managers.appUsersManager.getUser(myId) as Promise<User.user>,
        rootScope.managers.appProfileManager.getProfile(myId) as Promise<UserFull.userFull>
      ]);
      if(user?.phone) setPhone('+' + formatPhoneNumber(user.phone).formatted);
      const uname = user?.username || (user as any)?.usernames?.find((u: any) => u.pFlags?.active)?.username;
      if(uname) setUsername(uname);
      if(full?.about) setBio(full.about);
    } catch(e) {}
  });

  onCleanup(() => {
    listenerSetter.removeAll();
  });

  const avatar = AvatarNew({peerId: myId, size: 96, isDialog: false});
  const title = new PeerTitle({peerId: myId, dialog: false});

  return (
    <div class="svipe-profile">
      <div class="svipe-profile__scroll" ref={rootEl}>
        <div class="svipe-profile__header">
          <span class="svipe-profile__avatar">{avatar.node}</span>
          <div class="svipe-profile__name">{title.element}</div>
          <div class="svipe-profile__status">online</div>
        </div>

        {/* Android ProfileActionsView (74dp row, 4 glass buttons) */}
        <div class="svipe-profile__actions">
          {ACTIONS.map(({action, label, svg}) => (
            <button class="svipe-profile__action" onClick={() => props.onAction(action)}>
              <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d={svg} /></svg>
              <span>{label}</span>
            </button>
          ))}
        </div>

        <Show when={phone() || bio() || username()}>
          <div class="svipe-profile__card">
            <Show when={phone()}>
              <div class="svipe-profile__row" onClick={() => copyRow(phone())}>
                <div class="svipe-profile__row-value">{phone()}</div>
                <div class="svipe-profile__row-label">Mobile</div>
              </div>
            </Show>
            <Show when={bio()}>
              <div class="svipe-profile__row" onClick={() => copyRow(bio())}>
                <div class="svipe-profile__row-value svipe-profile__row-value--multiline">{bio()}</div>
                <div class="svipe-profile__row-label">Bio</div>
              </div>
            </Show>
            <Show when={username()}>
              <div class="svipe-profile__row" onClick={() => copyRow('@' + username())}>
                <div class="svipe-profile__row-value">@{username()}</div>
                <div class="svipe-profile__row-label">Username</div>
              </div>
            </Show>
          </div>
        </Show>

        <div class="svipe-profile__posts-header">
          Posts
          <Show when={postsCount() !== undefined}>
            <span class="svipe-profile__posts-count">{postsCount()}</span>
          </Show>
        </div>
        <div class="svipe-profile__posts" ref={postsEl}>
          <Show when={postsCount() === 0}>
            <div class="svipe-profile__posts-empty">Hozircha postlar yo'q</div>
          </Show>
        </div>
      </div>
    </div>
  );
}
