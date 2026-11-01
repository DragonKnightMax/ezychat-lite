import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { LiteImportNotice, type LiteImportNoticeUpdate } from '@ezychat/shared';
import { api, errorMessage } from '../api/client';

export const liteNoticeKey = ['liteImport', 'notice'] as const;

/**
 * The after-import notice (admins): the team checklist and the "address changed" flag. Anything but a
 * clean answer (no import ever ran, an older server) counts as no notice.
 */
export function useLiteImportNotice(enabled = true) {
  return useQuery({
    queryKey: liteNoticeKey,
    queryFn: () => api('/lite-import/notice', { schema: LiteImportNotice }),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/** Ticks a checklist item or dismisses a card; the answer replaces the notice. */
export function useUpdateLiteImportNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LiteImportNoticeUpdate) =>
      api('/lite-import/notice', { method: 'PUT', body, schema: LiteImportNotice }),
    onSuccess: (notice) => qc.setQueryData(liteNoticeKey, notice),
    onError: (e) => toast.error(errorMessage(e)),
  });
}
