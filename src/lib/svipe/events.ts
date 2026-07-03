import {svipeFetch} from './api';

/**
 * Recsys telemetry, mirroring Android's ReelsActivity.sendEvent →
 * POST /v1/events. Always a single-element batch; failures are swallowed —
 * telemetry must never break playback.
 */
export type SvipeEventType =
  'IMPRESSION' | 'REPLAY' | 'VIDEO_END' | 'SWIPE_AWAY' |
  'LIKE' | 'UNLIKE' | 'SHARE' | 'FOLLOW' | 'UNFOLLOW' |
  'NOT_INTERESTED' | 'BLOCK_CHANNEL';

export type SvipeEventTarget = {
  channelId?: number;
  serverMsgId?: number;
  recommendationId?: string;
};

export function sendSvipeEvent(target: SvipeEventTarget, eventType: SvipeEventType, payload?: Record<string, any>) {
  if(!target.channelId || !target.serverMsgId) return;
  svipeFetch('/v1/events', {
    method: 'POST',
    body: {
      events: [{
        channel_id: target.channelId,
        message_id: target.serverMsgId,
        event_type: eventType,
        ...(target.recommendationId ? {recommendation_id: target.recommendationId} : {}),
        ...(payload ? {payload} : {})
      }]
    }
  }).catch(() => {});
}

/**
 * Watch classification, mirroring Android's SvipeWatchEvent: watching ≥150% of
 * the clip's duration is a REPLAY, ≥90% a VIDEO_END, anything less a
 * SWIPE_AWAY. Without a known duration it's always SWIPE_AWAY.
 */
export function classifyWatch(watchedMs: number, durationMs?: number): SvipeEventType {
  if(durationMs && durationMs > 0) {
    if(watchedMs >= durationMs * 1.5) return 'REPLAY';
    if(watchedMs >= durationMs * 0.9) return 'VIDEO_END';
  }
  return 'SWIPE_AWAY';
}
