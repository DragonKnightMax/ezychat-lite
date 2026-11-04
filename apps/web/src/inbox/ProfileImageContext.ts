import { createContext } from 'react';

/** Photos load only while WhatsApp is connected; shared by list and conversation copies. */
export const ProfileImageContext = createContext({ ready: true });
