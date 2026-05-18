import { supabase } from './supabase';

export type PageChangePayload  = { page: number };
export type SessionEndPayload  = { session_id: string };

export type CoViewingChannelCallbacks = {
  onPageChange?:  (page: number)  => void;
  onSessionEnd?:  (sessionId: string) => void;
};

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
