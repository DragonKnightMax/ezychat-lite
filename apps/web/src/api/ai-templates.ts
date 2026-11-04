import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AgentTemplateCatalog } from '@ezychat/shared';
import { api } from './client';

/**
 * AI agent templates from the signed template list (docs/features/template-store/design.md),
 * admins only. The gallery falls back to the app's own templates while these load or fail.
 */
export const templateCatalogKey = ['ai', 'templates'] as const;

/** The list as the server keeps it (no download). */
export function useTemplateCatalog(enabled = true) {
  return useQuery({
    queryKey: templateCatalogKey,
    queryFn: ({ signal }) => api('/ai/templates', { signal, schema: AgentTemplateCatalog }),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Downloads and checks the list now (the gallery opens). */
export function useRefreshTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api('/ai/templates/refresh', { method: 'POST', schema: AgentTemplateCatalog }),
    onSuccess: (catalog) => qc.setQueryData(templateCatalogKey, catalog),
  });
}
