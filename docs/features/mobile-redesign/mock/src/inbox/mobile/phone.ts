// Proposed (mobile-redesign): the phone layout is used below the `md` breakpoint (768 px), the same
// breakpoint at which the inbox already switches from two columns to one.
import { useMediaQuery } from '../../lib/use-media-query';

export const PHONE_QUERY = '(max-width: 767px)';

export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}

/** Quick filters that the phone chip row adds on top of the shared chat filters. */
export type QuickFilter = 'all' | 'unread' | 'mine' | 'unassigned' | 'groups';
