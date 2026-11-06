import 'i18next';
import type { enResources } from './resources';

// Typed keys: `t('common:actions.save')` is checked against the English catalogs.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: typeof enResources;
  }
}
