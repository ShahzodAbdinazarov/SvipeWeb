import type {Chat, Document, Message, User} from '@layer';
import getMediaFromMessage from '@appManagers/utils/messages/getMediaFromMessage';
import rootScope from '@lib/rootScope';
import {svipeGetJson} from '@lib/svipe/api';

/**
 * A single item in the reels feed: a Telegram video, addressed by the peer it
 * lives in plus its (client-generated) message id, with the resolved Document
 * ready to hand to the stream engine, plus the raw backend reference so
 * telemetry (/v1/events) and sharing can address it the way Android does.
 */
export type ReelItem = {
  peerId: PeerId;
  mid: number;
  doc: Document.document;
  message: Message.message;
  chatId?: ChatId;
  username?: string;
  // Raw backend reference (server-side ids, straight from /v1/feed|/v1/discover).
  channelId?: number;
  serverMsgId?: number;
  topicId?: number;
  shareUrl?: string;
  recommendationId?: string;
  feedPosition?: number;
};

/** A backend item reference, shared by /v1/feed, /v1/discover and /v1/share. */
export type DiscoverRef = {
  channel_id: number;
  message_id: number;
  username?: string | null;
  topic_id?: number | null;
  share_url?: string | null;
};

type BackendFeedResponse = {
  items?: DiscoverRef[];
  next_cursor?: string | null;
  recommendation_id?: string | null;
};

/** Seed for a continuation feed (Android's ReelsActivity.ofDiscoverSeed). */
export type FeedSeed = {channelId: number; messageId: number; topicId?: number};

// Cursor pagination state for the backend feed. undefined = not started,
// string = more pages, null = exhausted.
let nextCursor: string | null | undefined;
let usingBackend = false;
let feedPosition = 0;
let currentRecommendationId: string | undefined;

async function resolvePeer(username: string): Promise<{peerId: PeerId; chatId?: ChatId} | undefined> {
  const peer = await rootScope.managers.appUsersManager.resolveUsername(username);
  if(!peer) return undefined;
  if(peer._ === 'user') {
    return {peerId: (peer as User.user).id.toPeerId(false)};
  }
  const chatId = (peer as Chat.channel).id;
  return {peerId: chatId.toPeerId(true), chatId};
}

async function messageToReel(peerId: PeerId, mid: number, extras?: Partial<ReelItem>): Promise<ReelItem | undefined> {
  const message = await rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid);
  if(!message || message._ !== 'message') return undefined;

  const doc = getMediaFromMessage(message, true);
  if(doc?._ !== 'document') return undefined;
  if(!doc.mime_type?.startsWith('video')) return undefined;

  return {peerId, mid, doc, message: message as Message.message, ...extras};
}

/**
 * Resolve a backend {username, message_id} reference to a playable Telegram
 * video. Shared by the reels feed, the explore grid tap and share deep-links.
 */
export async function resolveDiscoverRef(item: DiscoverRef, extras?: Partial<ReelItem>): Promise<ReelItem | undefined> {
  if(!item.username) return undefined;

  const resolved = await resolvePeer(item.username);
  if(!resolved) return undefined;
  const {peerId, chatId} = resolved;

  // Backend sends the raw server message id; tweb addresses messages by a
  // generated mid (and channels.getMessages needs the peer's access hash, which
  // resolveUsername just cached).
  const mid = await rootScope.managers.appMessagesIdsManager.generateMessageId(item.message_id, chatId);
  await rootScope.managers.appMessagesManager.reloadMessages(peerId, [mid]);
  return messageToReel(peerId, mid, {
    chatId,
    username: item.username,
    channelId: item.channel_id,
    serverMsgId: item.message_id,
    topicId: item.topic_id ?? undefined,
    shareUrl: item.share_url ?? undefined,
    ...extras
  });
}

/**
 * Resolve a page of backend refs with per-channel batching (Android's
 * SvipeExploreGrid.resolveThumbnails): one resolveUsername + one
 * reloadMessages per channel instead of per item. Returns items in the input
 * order, with unresolvable refs as undefined.
 */
export async function resolveDiscoverRefsBatched(refs: DiscoverRef[]): Promise<(ReelItem | undefined)[]> {
  const byUsername = new Map<string, {ref: DiscoverRef; index: number}[]>();
  refs.forEach((ref, index) => {
    const username = ref.username?.toLowerCase();
    if(!username) return;
    let group = byUsername.get(username);
    if(!group) byUsername.set(username, group = []);
    group.push({ref, index});
  });

  const out: (ReelItem | undefined)[] = new Array(refs.length).fill(undefined);
  await Promise.all([...byUsername.entries()].map(async([username, group]) => {
    try {
      const resolved = await resolvePeer(username);
      if(!resolved) return;
      const {peerId, chatId} = resolved;

      const mids = await Promise.all(group.map(({ref}) =>
        rootScope.managers.appMessagesIdsManager.generateMessageId(ref.message_id, chatId)));
      await rootScope.managers.appMessagesManager.reloadMessages(peerId, mids);

      await Promise.all(group.map(async({ref, index}, i) => {
        out[index] = await messageToReel(peerId, mids[i], {
          chatId,
          username: ref.username || undefined,
          channelId: ref.channel_id,
          serverMsgId: ref.message_id,
          topicId: ref.topic_id ?? undefined,
          shareUrl: ref.share_url ?? undefined
        }).catch((): ReelItem | undefined => undefined);
      }));
    } catch(e) {
      // leave the group unresolved
    }
  }));
  return out;
}

/**
 * Resolve refs with bounded parallelism, emitting the ORDERED prefix as it
 * completes. Strictly sequential resolution (3-4 MTProto round-trips × a full
 * page) kept the boot-time reels surface on its spinner for many seconds —
 * the app looked frozen until the first video played. Parallel workers cut
 * the total wall-clock ~4×, and the prefix callback lets the viewer start
 * playing item 0 as soon as it alone is ready.
 */
async function resolveRefsOrdered(
  refs: DiscoverRef[],
  extrasFor: (ref: DiscoverRef, i: number) => Partial<ReelItem>,
  onPrefix?: (items: ReelItem[]) => void
): Promise<ReelItem[]> {
  const CONCURRENCY = 4;
  const results: (ReelItem | null | undefined)[] = new Array(refs.length).fill(undefined);
  const emitted: ReelItem[] = [];
  let nextEmit = 0;
  let cursor = 0;

  const emit = () => {
    let grew = false;
    while(nextEmit < refs.length && results[nextEmit] !== undefined) {
      const item = results[nextEmit++];
      if(item) {
        emitted.push(item);
        grew = true;
      }
    }
    if(grew) onPrefix?.(emitted.slice());
  };

  await Promise.all(new Array(Math.min(CONCURRENCY, refs.length)).fill(0).map(async() => {
    while(cursor < refs.length) {
      const i = cursor++;
      results[i] = (await resolveDiscoverRef(refs[i], extrasFor(refs[i], i))
      .catch((): ReelItem | undefined => undefined)) ?? null;
      emit();
    }
  }));
  return emitted;
}

async function loadBackendPage(query: string, onPrefix?: (items: ReelItem[]) => void): Promise<ReelItem[]> {
  const data = await svipeGetJson<BackendFeedResponse>('/v1/feed' + query);
  if(!data) throw new Error('svipe feed unavailable');

  nextCursor = data.next_cursor ?? null;
  currentRecommendationId = data.recommendation_id ?? undefined;

  const refs = data.items || [];
  const basePosition = feedPosition;
  feedPosition += refs.length;
  const recommendationId = currentRecommendationId;
  return resolveRefsOrdered(refs, (ref, i) => ({
    recommendationId,
    feedPosition: basePosition + i
  }), onPrefix);
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
  const {peerId, chatId} = resolved;

  const history = await rootScope.managers.appMessagesManager.getHistory({
    peerId,
    limit: SEED_HISTORY_LIMIT,
    inputFilter: {_: 'inputMessagesFilterVideo'}
  });

  const items: ReelItem[] = [];
  for(const mid of history.history) {
    const reel = await messageToReel(peerId, mid, {chatId, username}).catch((): ReelItem | undefined => undefined);
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

/**
 * First page of the reels feed: the real recsys backend, seed channels as
 * fallback. An optional seed (a tapped explore-grid cell) makes the backend
 * condition the continuation on that video, mirroring Android's
 * `/v1/feed?seed_channel_id=…&seed_message_id=…`.
 */
export async function getReelsFeed(seed?: FeedSeed, onPrefix?: (items: ReelItem[]) => void): Promise<ReelItem[]> {
  nextCursor = undefined;
  usingBackend = false;
  feedPosition = 0;
  currentRecommendationId = undefined;
  try {
    const query = seed ?
      `?seed_channel_id=${seed.channelId}&seed_message_id=${seed.messageId}` +
        (seed.topicId ? `&seed_topic_id=${seed.topicId}` : '') :
      '';
    const items = await loadBackendPage(query, onPrefix);
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
    const ref = await svipeGetJson<DiscoverRef>(`/v1/share/${encodeURIComponent(code)}`, false);
    if(!ref) return undefined;
    return await resolveDiscoverRef(ref);
  } catch(e) {
    return undefined;
  }
}

/** Next page (backend only; cursor-paginated). Returns [] when exhausted or on the seed fallback. */
export async function loadMoreReels(): Promise<ReelItem[]> {
  if(!usingBackend || nextCursor === null || nextCursor === undefined) return [];
  try {
    return await loadBackendPage(`?cursor=${encodeURIComponent(nextCursor)}`);
  } catch(e) {
    return [];
  }
}
