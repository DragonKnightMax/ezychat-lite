import { useAuth } from '../auth/AuthProvider';
import { accessOf, canOpen, useMockInboxes, type MockInbox } from '../mock/inboxes';

/** Proposed (multi-inbox): the inboxes the signed-in user may open (admins: all). */
export function useVisibleInboxes(): MockInbox[] {
  const state = useMockInboxes();
  const { user } = useAuth();
  const access = accessOf(state, user);
  return state.inboxes.filter((i) => canOpen(access, i.id));
}
