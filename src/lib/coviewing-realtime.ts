import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type PageChangePayload  = { page: number };
export type SessionEndPayload  = { session_id: string };

// Presence metadata recipients publish on the session channel. Updated
// when page or following-mode changes; auto-cleared on disconnect.
export type RecipientPresence = {
  email:     string;
  page:      number;
  following: boolean;
  joined_at: string; // ISO captured at first track()
};

export type CoViewingChannelCallbacks = {
  onPageChange?:  (page: number)  => void;
  onSessionEnd?:  (sessionId: string) => void;
};

export type CoViewingPresenceCallbacks = {
  onPresenceSync?:  (state: Record<string, RecipientPresence[]>) => void;
  onPresenceJoin?:  (newPresences: RecipientPresence[]) => void;
  onPresenceLeave?: (leftPresences: RecipientPresence[]) => void;
};

// Returns a fresh channel. Caller is responsible for:
//   1. Attaching listeners via attachBroadcasts / attachPresence
//   2. Calling ch.subscribe() (with status callback if it needs to track)
//   3. Calling supabase.removeChannel(ch) on cleanup
export function createCoViewingChannel(channelName: string): RealtimeChannel {
  return supabase.channel(channelName);
}

export function attachBroadcasts(
  ch: RealtimeChannel,
  callbacks: CoViewingChannelCallbacks,
): RealtimeChannel {
  if (callbacks.onPageChange) {
    ch.on('broadcast', { event: 'page_change' }, ({ payload }) => {
      callbacks.onPageChange!((payload as PageChangePayload).page);
    });
  }
  if (callbacks.onSessionEnd) {
    ch.on('broadcast', { event: 'session_ended' }, ({ payload }) => {
      callbacks.onSessionEnd!((payload as SessionEndPayload).session_id);
    });
  }
  return ch;
}

export function attachPresence(
  ch: RealtimeChannel,
  callbacks: CoViewingPresenceCallbacks,
): RealtimeChannel {
  if (callbacks.onPresenceSync) {
    ch.on('presence', { event: 'sync' }, () => {
      callbacks.onPresenceSync!(ch.presenceState() as unknown as Record<string, RecipientPresence[]>);
    });
  }
  if (callbacks.onPresenceJoin) {
    ch.on('presence', { event: 'join' }, ({ newPresences }) => {
      callbacks.onPresenceJoin!(newPresences as unknown as RecipientPresence[]);
    });
  }
  if (callbacks.onPresenceLeave) {
    ch.on('presence', { event: 'leave' }, ({ leftPresences }) => {
      callbacks.onPresenceLeave!(leftPresences as unknown as RecipientPresence[]);
    });
  }
  return ch;
}

// Legacy fire-and-forget helper kept for callers that don't track
// presence. CoViewingRecipient still uses this for its broadcast
// subscription and tracks presence on a separate channel object.
export function subscribeCoViewingChannel(
  channel: string,
  callbacks: CoViewingChannelCallbacks,
) {
  const sub = supabase
    .channel(channel)
    .on('broadcast', { event: 'page_change' }, ({ payload }) => {
      callbacks.onPageChange?.((payload as PageChangePayload).page);
    })
    .on('broadcast', { event: 'session_ended' }, ({ payload }) => {
      callbacks.onSessionEnd?.((payload as SessionEndPayload).session_id);
    })
    .subscribe();

  return () => { supabase.removeChannel(sub); };
}

export async function broadcastPageChange(channel: string, page: number) {
  await supabase.channel(channel).send({
    type: 'broadcast', event: 'page_change', payload: { page },
  });
}
