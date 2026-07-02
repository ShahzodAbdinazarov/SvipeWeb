import type {Chat, Document, Message, User} from '@layer';
import getMediaFromMessage from '@appManagers/utils/messages/getMediaFromMessage';
import rootScope from '@lib/rootScope';
import {svipeGetJson} from '@lib/svipe/api';

/**
 * A single item in the reels feed: a Telegram video, addressed by the peer it
 * lives in plus its (client-generated) message id, with the resolved Document
 * ready to hand to the stream engine.
 */
export type ReelItem = {
  peerId: PeerId;
  mid: number;
  doc: Document.document;
  message: Message.message;
};

type BackendFeedItem = {
  channel_id: number;
  message_id: number;
  username?: string | null;
};

type BackendFeedResponse = {
  items?: BackendFeedItem[];
  next_cursor?: string | null;
};

// Cursor pagination state for the backend feed. undefined = not started,
// string = more pages, null = exhausted.
let nextCursor: string | null | undefined;
let usingBackend = false;

async function resolvePeer(username: string): Promise<{peerId: PeerId; chatId?: ChatId} | undefined> {
  const peer = await rootScope.managers.appUsersManager.resolveUsername(username);
  if(!peer) return undefined;
  if(peer._ === 'user') {
    return {peerId: (peer as User.user).id.toPeerId(false)};
  }
  const chatId = (peer as Chat.channel).id;
  return {peerId: chatId.toPeerId(true), chatId};
}

async function messageToReel(peerId: PeerId, mid: number): Promise<ReelItem | undefined> {
  const message = await rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid);
  if(!message || message._ !== 'message') return undefined;

  const doc = getMediaFromMessage(message, true);
  if(doc?._ !== 'document') return undefined;
  if(!doc.mime_type?.startsWith('video')) return undefined;

  return {peerId, mid, doc, message: message as Message.message};
}

/** Resolve a backend {username, message_id} reference to a playable Telegram video. */
async function resolveFeedItem(item: BackendFeedItem): Promise<ReelItem | undefined> {
  if(!item.username) return undefined;

  const resolved = await resolvePeer(item.username);
  if(!resolved) return undefined;
  const {peerId, chatId} = resolved;

  // Backend sends the raw server message id; tweb addresses messages by a
  // generated mid (and channels.getMessages needs the peer's access hash, which
  // resolveUsername just cached).
  const mid = await rootScope.managers.appMessagesIdsManager.generateMessageId(item.message_id, chatId);
  await rootScope.managers.appMessagesManager.reloadMessages(peerId, [mid]);
  return messageToReel(peerId, mid);
}

async function loadBackendPage(cursor?: string): Promise<ReelItem[]> {
  const path = cursor ? `/v1/feed?cursor=${encodeURIComponent(cursor)}` : '/v1/feed';
  const data = await svipeGetJson<BackendFeedResponse>(path);
  if(!data) throw new Error('svipe feed unavailable');

  nextCursor = data.next_cursor ?? null;

  const items: ReelItem[] = [];
  for(const item of data.items || []) {
    const reel = await resolveFeedItem(item).catch((): ReelItem | undefined => undefined);
    if(reel) items.push(reel);
  }
  return items;
}

// ---- Seed fallback: public channels over MTProto, used only if the backend
// feed is unreachable (e.g. auth not yet granted). Same pipeline shape. ----

const SEED_CHANNELS = ['telegram', 'durov'];
const SEED_HISTORY_LIMIT = 40;

function shuffle<T>(arr: T[]): T[] {
  for(let i = arr.length - 1; i > 0; i--) {
    const j = (i * 7 + 3) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function loadSeedChannel(username: string): Promise<ReelItem[]> {
  const resolved = await resolvePeer(username);
  if(!resolved) return [];
  const {peerId} = resolved;

  const history = await rootScope.managers.appMessagesManager.getHistory({
    peerId,
    limit: SEED_HISTORY_LIMIT,
    inputFilter: {_: 'inputMessagesFilterVideo'}
  });

  const items: ReelItem[] = [];
  for(const mid of history.history) {
    const reel = await messageToReel(peerId, mid).catch((): ReelItem | undefined => undefined);
    if(reel) items.push(reel);
  }
  return items;
}

async function getSeedFeed(): Promise<ReelItem[]> {
  const perChannel = await Promise.all(
    SEED_CHANNELS.map((u) => loadSeedChannel(u).catch(() => [] as ReelItem[]))
  );
  return shuffle(perChannel.flat());
}

/** First page of the reels feed: the real recsys backend, seed channels as fallback. */
export async function getReelsFeed(): Promise<ReelItem[]> {
  nextCursor = undefined;
  usingBackend = false;
  try {
    const items = await loadBackendPage();
    if(items.length) {
      usingBackend = true;
      return items;
    }
  } catch(e) {
    // fall through to seed
  }
  return getSeedFeed();
}

/**
 * Resolve a share {code} (from a svipe.uz/{code} link) to a single playable
 * reel via the backend, so a deep-link can open that exact video first.
 */
export async function getSeedReel(code: string): Promise<ReelItem | undefined> {
  try {
    // Share resolution is public reference data — no backend auth needed.
    const ref = await svipeGetJson<BackendFeedItem>(`/v1/share/${encodeURIComponent(code)}`, false);
    if(!ref) return undefined;
    const reel = await resolveFeedItem(ref);
    return reel;
  } catch(e) {
    return undefined;
  }
}

/** Next page (backend only; cursor-paginated). Returns [] when exhausted or on the seed fallback. */
export async function loadMoreReels(): Promise<ReelItem[]> {
  if(!usingBackend || nextCursor === null || nextCursor === undefined) return [];
  try {
    return await loadBackendPage(nextCursor);
  } catch(e) {
    return [];
  }
}
