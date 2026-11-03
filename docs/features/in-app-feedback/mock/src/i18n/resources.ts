import admin from './locales/en/admin.json';
import app from './locales/en/app.json';
import auth from './locales/en/auth.json';
import common from './locales/en/common.json';
import errors from './locales/en/errors.json';
import inbox from './locales/en/inbox.json';

/** Namespaces: one JSON file per namespace per locale under ./locales/<locale>/. */
export const NAMESPACES = ['common', 'app', 'auth', 'inbox', 'admin', 'errors'] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** English is the source language: always bundled, and the fallback for missing keys. */
export const enResources = { common, app, auth, inbox, admin, errors } satisfies Record<
  Namespace,
  object
>;
