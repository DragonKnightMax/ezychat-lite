import type { AgentTemplateCatalog, AgentTemplateListStatus } from '@ezychat/shared';

/** What the template list module offers the rest of the server (ctx.services.templateList). */
export interface TemplateListService {
  status(): AgentTemplateListStatus;
  /** The entries this app and edition can use, with their recommended connectors' names. */
  catalog(): AgentTemplateCatalog;
  /** Downloads and checks the list now (deduplicated, at most once per 30 s); resolves with the catalog. */
  refresh(): Promise<AgentTemplateCatalog>;
  shutdown(): void;
}

declare module '../context.js' {
  interface Services {
    templateList?: TemplateListService;
  }
}
