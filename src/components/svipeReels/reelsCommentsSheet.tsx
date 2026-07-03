import {createSignal, For, onMount, Show} from 'solid-js';
import type {Message} from '@layer';
import rootScope from '@lib/rootScope';
import getPeerId from '@appManagers/utils/peers/getPeerId';
import getServerMessageId from '@appManagers/utils/messageId/getServerMessageId';
import {AvatarNew} from '@components/avatarNew';
import PeerTitle from '@components/peerTitle';
import {i18n} from '@lib/langPack';
import formatRelativeTime from '@helpers/date/formatRelativeTime';
import wrapEmojiText from '@lib/richTextProcessor/wrapEmojiText';
import type {ReelItem} from './reelsFeed';

import './reelsCommentsSheet.scss';

type CommentRow = {
  fromPeerId: PeerId;
  date: number;
  text: string;
};

/**
 * Instagram-style dark comments sheet over a playing reel, ported from
 * Android's SvipeReelsCommentsSheet: 75% height, drag-handle, chronological
 * Telegram discussion-group comments, optimistic posting.
 *
 * Like Android, comments are fetched with messages.getReplies directly on the
 * channel post (messages.getDiscussionMessage returned empty roots for some
 * channels there); the discussion root for *sending* is resolved lazily via
 * getDiscussionMessage only when the user actually posts.
 */
export default function ReelsCommentsSheet(props: {
  item: ReelItem;
  count: number;
  onCountChange: (count: number) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = createSignal<CommentRow[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [disabled, setDisabled] = createSignal(false);
  const [text, setText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [count, setCount] = createSignal(props.count);
  const [dragY, setDragY] = createSignal(0);

  let listEl!: HTMLDivElement;
  let rootEl!: HTMLDivElement;
  // Resolved on first send: the thread root inside the discussion group.
  let sendRoot: Promise<{peerId: PeerId; mid: number}> | undefined;

  const commentsEnabled = !!(props.item.message.replies as any)?.pFlags?.comments;

  onMount(async() => {
    // Touches outside the comments list must not scroll-snap the reel pager
    // underneath (the list itself chains-blocks via overscroll-behavior).
    rootEl.addEventListener('touchmove', (e) => {
      if(!(e.target as HTMLElement).closest?.('.svipe-comments__list')) e.preventDefault();
    }, {passive: false});

    if(!commentsEnabled) {
      setDisabled(true);
      setLoading(false);
      return;
    }
    try {
      const managers = rootScope.managers;
      const peer = await managers.appPeersManager.getInputPeerById(props.item.peerId);
      const res: any = await managers.apiManager.invokeApi('messages.getReplies', {
        peer,
        msg_id: getServerMessageId(props.item.mid),
        offset_id: 0,
        offset_date: 0,
        add_offset: 0,
        limit: 40,
        max_id: 0,
        min_id: 0,
        hash: 0
      });
      // Save the side users/chats so avatars and titles resolve.
      await managers.appUsersManager.saveApiUsers(res.users || []);
      await managers.appChatsManager.saveApiChats(res.chats || []);

      const messages: Message.message[] = (res.messages || []).filter((m: Message) => m._ === 'message');
      // Newest-first from the server → chronological, oldest on top.
      const parsed = messages.map((m) => ({
        fromPeerId: m.from_id ? getPeerId(m.from_id) : getPeerId(m.peer_id),
        date: m.date,
        text: m.message || ''
      })).reverse();
      setRows(parsed);
    } catch(e) {
      setDisabled(true);
    } finally {
      setLoading(false);
      queueMicrotask(() => listEl && (listEl.scrollTop = listEl.scrollHeight));
    }
  });

  const resolveSendRoot = () => {
    return sendRoot ??= rootScope.managers.appMessagesManager
    .getDiscussionMessage(props.item.peerId, props.item.mid)
    .then((root: any) => ({peerId: root.peerId as PeerId, mid: root.mid as number}));
  };

  const send = async() => {
    const value = text().trim();
    if(!value || sending()) return;
    setSending(true);
    try {
      const root = await resolveSendRoot();
      await rootScope.managers.appMessagesManager.sendText({
        peerId: root.peerId,
        threadId: root.mid,
        text: value
      });
      // Optimistic UI, like Android: clear input, append local row, bump count.
      setText('');
      setRows((prev) => [...prev, {fromPeerId: rootScope.myId, date: Date.now() / 1000 | 0, text: value}]);
      const next = count() + 1;
      setCount(next);
      props.onCountChange(next);
      queueMicrotask(() => listEl && (listEl.scrollTop = listEl.scrollHeight));
    } catch(e) {
      // keep the text so the user can retry
    } finally {
      setSending(false);
    }
  };

  const renderName = (peerId: PeerId) => {
    const title = new PeerTitle({peerId, dialog: false});
    return title.element;
  };

  const renderTime = (date: number) => {
    const rel = formatRelativeTime(date, Date.now() / 1000 | 0);
    return i18n(rel.key, rel.args);
  };

  const renderAvatar = (peerId: PeerId) => {
    const avatar = AvatarNew({peerId, size: 34, isDialog: false});
    return avatar.node;
  };

  // Swipe-down-to-dismiss on the handle/header area.
  let dragStartY: number | undefined;
  const onDragStart = (e: TouchEvent) => {
    dragStartY = e.touches[0].clientY;
  };
  const onDragMove = (e: TouchEvent) => {
    if(dragStartY === undefined) return;
    setDragY(Math.max(0, e.touches[0].clientY - dragStartY));
  };
  const onDragEnd = () => {
    if(dragStartY === undefined) return;
    const y = dragY();
    dragStartY = undefined;
    if(y > 120) props.onClose();
    else setDragY(0);
  };

  return (
    <div class="svipe-comments" ref={rootEl} onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div
        class="svipe-comments__sheet"
        style={{transform: dragY() ? `translateY(${dragY()}px)` : undefined, transition: dragY() ? 'none' : undefined}}
      >
        <div
          class="svipe-comments__grip"
          onTouchStart={onDragStart}
          onTouchMove={onDragMove}
          onTouchEnd={onDragEnd}
        >
          <div class="svipe-comments__handle" />
          <div class="svipe-comments__title">Izohlar</div>
          <Show when={!disabled()}>
            <div class="svipe-comments__count">{count()}</div>
          </Show>
        </div>

        <div class="svipe-comments__list" ref={listEl}>
          <Show when={loading()}>
            <div class="svipe-comments__center"><div class="svipe-reels__spinner" /></div>
          </Show>

          <Show when={!loading() && !disabled() && rows().length === 0}>
            <div class="svipe-comments__center svipe-comments__empty">
              <div class="svipe-comments__empty-title">Hozircha izohlar yo'q</div>
              <div class="svipe-comments__empty-sub">Birinchi bo'lib fikr bildiring</div>
            </div>
          </Show>

          <Show when={disabled()}>
            <div class="svipe-comments__center svipe-comments__empty">
              <div class="svipe-comments__empty-title">Izohlar o'chirilgan</div>
            </div>
          </Show>

          <For each={rows()}>
            {(row) => (
              <div class="svipe-comments__row">
                <span class="svipe-comments__avatar">{renderAvatar(row.fromPeerId)}</span>
                <div class="svipe-comments__body">
                  <div class="svipe-comments__meta">
                    <span class="svipe-comments__name">{renderName(row.fromPeerId)}</span>
                    <span class="svipe-comments__time">{renderTime(row.date)}</span>
                  </div>
                  <div class="svipe-comments__text">{wrapEmojiText(row.text)}</div>
                </div>
              </div>
            )}
          </For>
        </div>

        <Show when={!disabled()}>
          <div class="svipe-comments__input-bar">
            <input
              class="svipe-comments__input"
              type="text"
              placeholder="Izoh qo'shing…"
              value={text()}
              onInput={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            <button
              class="svipe-comments__send"
              classList={{'svipe-comments__send--enabled': !!text().trim() && !sending()}}
              onClick={send}
              aria-label="Send"
            >
              <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}
