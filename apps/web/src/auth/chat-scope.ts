import type { User } from '@ezychat/shared';
import { useAuth } from './AuthProvider';

/**
 * An agent limited to chosen chats (`User.chatScope === 'chosen'`): no Ask Ezy (it reads across
 * chats) and no chat opened or started from a group member. The server refuses both anyway.
 */
export function chosenChatsOnly(
  user: Pick<User, 'role' | 'chatScope'> | null | undefined,
): boolean {
  return user?.role === 'agent' && user.chatScope === 'chosen';
}

export function useChosenChatsOnly(): boolean {
  return chosenChatsOnly(useAuth().user);
}
