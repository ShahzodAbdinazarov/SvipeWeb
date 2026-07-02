import type {Document, Message} from '@layer';
import getMediaFromMessage from '@appManagers/utils/messages/getMediaFromMessage';
import rootScope from '@lib/rootScope';

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

/**
 * v1 content source.
 *
 * The Svipe recommender backend (GET /v1/feed, see docs/handoff) returns the
 * real reels feed as {channel_id, message_id} references, but that path needs a
 * backend JWT minted from Telegram Mini-App initData — a separate piece still to
 * be wired. Until then we seed the feed directly from a few public channels the
 * client can resolve over MTProto, exercising the exact same
 * resolve -> load history -> Document -> stream pipeline the backend feed will
 * use. Swap getReelsFeed()'s body for the /v1/feed call once auth lands; the
 * ReelItem shape and everything downstream stay the same.
 */
const SEED_CHANNELS = ['telegram', 'durov'];

const HISTORY_LIMIT = 40;

function shuffle<T>(arr: T[]): T[] {
  for(let i = arr.length - 1; i > 0; i--) {
    // Deterministic-enough interleave; reels order needn't be cryptographic.
    const j = (i * 7 + 3) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function resolvePeerId(username: string): Promise<PeerId | undefined> {
  const peer = await rootScope.managers.appUsersManager.resolveUsername(username);
  if(!peer) return undefined;
  return peer._ === 'user' ?
    (peer.id as UserId).toPeerId(false) :
    (peer.id as ChatId).toPeerId(true);
}

async function loadChannelVideos(username: string): Promise<ReelItem[]> {
  const items: ReelItem[] = [];
  const peerId = await resolvePeerId(username);
  if(!peerId) return items;

  const history = await rootScope.managers.appMessagesManager.getHistory({
    peerId,
    limit: HISTORY_LIMIT,
    inputFilter: {_: 'inputMessagesFilterVideo'}
  });

  for(const mid of history.history) {
    const message = await rootScope.managers.appMessagesManager.getMessageByPeer(peerId, mid);
    if(!message || message._ !== 'message') continue;

    const doc = getMediaFromMessage(message, true);
    if(doc?._ !== 'document') continue;
    if(!doc.mime_type?.startsWith('video')) continue;

    items.push({peerId, mid, doc, message: message as Message.message});
  }

  return items;
}

export async function getReelsFeed(): Promise<ReelItem[]> {
  const perChannel = await Promise.all(
    SEED_CHANNELS.map((username) => loadChannelVideos(username).catch(() => [] as ReelItem[]))
  );
  return shuffle(perChannel.flat());
}
