import { createContext } from 'react';

/** One connection generation shared by every photo, including list and conversation copies. */
export const ProfileImageContext = createContext({ ready: true, revision: 0 });
