import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AiDocumentView,
  AiEditResult,
  AiMemberStatus,
  AiModelList,
  AiTestResult,
  AiTryResult,
  type AiMemberBody,
  type AiConnectionBody,
  type AiContextPatchBody,
  type AiContextTextBody,
  type AiEditBody,
  type AiTryBody,
} from '@ezychat/shared';
import { api, ApiError } from './client';
import { qk } from './queries';
import { voiceStatusKey } from './voice';

export const aiMemberKey = ['ai-member'] as const;

export function useAiMember() {
  return useQuery({
    queryKey: aiMemberKey,
    queryFn: ({ signal }) => api('/ai', { signal, schema: AiMemberStatus }),
    refetchInterval: (query) =>
      query.state.data?.connection.state === 'signing_in' ? 2000 : false,
  });
}

/** One Business context item with its text (full for text items, a preview for files). */
export function useAiDocument(id: number | null) {
  return useQuery({
    queryKey: ['ai-document', id] as const,
    queryFn: ({ signal }) => api(`/ai/documents/${id}`, { signal, schema: AiDocumentView }),
    enabled: id !== null,
    staleTime: 0,
    gcTime: 0,
  });
}

/** EXPERIMENTAL direct ChatGPT sign-in: live models for the signed-in account (or a fallback). */
export function useAiModels(enabled: boolean, connected: boolean) {
  return useQuery({
    queryKey: ['ai-models', connected] as const,
    queryFn: ({ signal }) => api('/ai/models', { signal, schema: AiModelList }),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useAiTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/ai/chatgpt/test', { method: 'POST', schema: AiTestResult }),
    onSettled: () => void qc.invalidateQueries({ queryKey: aiMemberKey }),
  });
}

/** Try it: answers from the page's current knowledge; never touches chats or WhatsApp. */
export function useAiTry() {
  return useMutation({
    mutationFn: (body: AiTryBody) => api('/ai/try', { method: 'POST', body, schema: AiTryResult }),
  });
}

/** Edit with AI: a suggested rewrite of one box; nothing is saved (the page's Save does that). */
/** Edit with AI. Pass a signal so closing the popup stops the (paid) model call. */
export function useAiEdit() {
  return useMutation({
    mutationFn: ({ body, signal }: { body: AiEditBody; signal: AbortSignal }) =>
      api('/ai/edit', { method: 'POST', body, schema: AiEditResult, signal }),
  });
}

export type AiMemberAction =
  | { kind: 'save'; settings: AiMemberBody }
  | { kind: 'connection'; settings: AiConnectionBody }
  | { kind: 'upload'; file: File }
  | { kind: 'remove'; id: number }
  | { kind: 'removeMany'; ids: number[] }
  | { kind: 'addText'; body: AiContextTextBody }
  | { kind: 'updateText'; id: number; body: AiContextPatchBody }
  | { kind: 'login' }
  | { kind: 'logout' }
  | { kind: 'callback'; url: string };

/** Some items of a batch delete failed (not 404); `failedIds` are the ones to retry. */
export class BatchDeleteError extends Error {
  constructor(
    readonly failedIds: number[],
    readonly firstError: unknown,
  ) {
    super(firstError instanceof Error ? firstError.message : 'Some items could not be deleted');
    this.name = 'BatchDeleteError';
  }
}

export function useAiMemberAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (action: AiMemberAction) => {
      const schema = AiMemberStatus;
      switch (action.kind) {
        case 'save':
          return api('/ai', { method: 'PUT', body: action.settings, schema });
        case 'connection':
          return api('/ai/connection', { method: 'PATCH', body: action.settings, schema });
        case 'upload': {
          const form = new FormData();
          form.append('file', action.file);
          return api('/ai/documents', { form, schema });
        }
        case 'remove':
          return api(`/ai/documents/${action.id}`, { method: 'DELETE', schema });
        case 'removeMany': {
          // One request per item, in order. 404 = already gone (counts as deleted); other errors
          // are collected so the caller can retry only those items.
          let status: AiMemberStatus | undefined;
          const failedIds: number[] = [];
          let firstError: unknown;
          for (const id of action.ids) {
            try {
              status = await api(`/ai/documents/${id}`, { method: 'DELETE', schema });
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) {
                status = undefined;
                continue;
              }
              failedIds.push(id);
              firstError ??= error;
            }
          }
          if (failedIds.length > 0) throw new BatchDeleteError(failedIds, firstError);
          return status ?? api('/ai', { schema });
        }
        case 'addText':
          return api('/ai/documents/text', { method: 'POST', body: action.body, schema });
        case 'updateText':
          return api(`/ai/documents/${action.id}`, { method: 'PATCH', body: action.body, schema });
        case 'login':
          return api('/ai/chatgpt/login', { method: 'POST', schema });
        case 'logout':
          return api('/ai/chatgpt/logout', { method: 'POST', schema });
        case 'callback':
          return api('/ai/chatgpt/callback', { method: 'POST', body: { url: action.url }, schema });
      }
    },
    onSuccess: (status) => {
      qc.setQueryData(aiMemberKey, status);
      qc.removeQueries({ queryKey: ['ai-document'] });
      void qc.invalidateQueries({ queryKey: qk.users });
      // Cloud voice transcription depends on the saved API key.
      void qc.invalidateQueries({ queryKey: voiceStatusKey });
    },
    // A batch delete can fail part-way: reload what the server has now.
    onError: () => void qc.invalidateQueries({ queryKey: aiMemberKey }),
  });
}
