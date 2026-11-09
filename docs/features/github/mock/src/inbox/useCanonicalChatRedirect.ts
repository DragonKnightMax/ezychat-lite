import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChat } from '../api/queries';
import { encodeJid } from '../lib/jid';

/** Old links and push notifications: follow the chat JID the server answered with. */
export function useCanonicalChatRedirect(jid: string | null): void {
  const chat = useChat(jid);
  const navigate = useNavigate();
  const location = useLocation();
  const canonical = chat.data?.chat.jid;
  useEffect(() => {
    if (jid && canonical && canonical !== jid) {
      navigate(`/chats/${encodeJid(canonical)}`, { replace: true, state: location.state });
    }
  }, [jid, canonical, navigate, location.state]);
}
