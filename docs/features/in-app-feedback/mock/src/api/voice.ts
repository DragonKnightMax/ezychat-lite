import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { VoiceStatus, type VoiceTranscription } from '@ezychat/shared';
import { api } from './client';

export const voiceStatusKey = ['ai-voice'] as const;

/** Settings → AI → Voice messages. Socket `voice:status` updates it live; polling is a fallback. */
export function useVoiceStatus() {
  return useQuery({
    queryKey: voiceStatusKey,
    queryFn: ({ signal }) => api('/ai/voice', { signal, schema: VoiceStatus }),
    refetchInterval: (query) => (query.state.data?.model.state === 'downloading' ? 2000 : false),
  });
}

export type VoiceAction =
  | { kind: 'set'; transcription: VoiceTranscription }
  | { kind: 'download' }
  | { kind: 'cancel' }
  | { kind: 'remove' };

export function useVoiceAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: VoiceAction) => {
      switch (action.kind) {
        case 'set':
          return api('/ai/voice', {
            method: 'PATCH',
            body: { transcription: action.transcription },
            schema: VoiceStatus,
          });
        case 'download':
          return api('/ai/voice/download', { method: 'POST', schema: VoiceStatus });
        case 'cancel':
          return api('/ai/voice/cancel', { method: 'POST', schema: VoiceStatus });
        case 'remove':
          return api('/ai/voice/model', { method: 'DELETE', schema: VoiceStatus });
      }
    },
    onSuccess: (status) => qc.setQueryData(voiceStatusKey, status),
    onError: () => void qc.invalidateQueries({ queryKey: voiceStatusKey }),
  });
}
