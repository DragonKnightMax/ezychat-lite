import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CopyButton } from './adminUi';

/** Command snippets are never translated: they are pasted into a terminal or a JSON file. */
export function claudeCodeCommand(endpoint: string, secret: string): string {
  return `claude mcp add --transport http ezychat ${endpoint} --header "Authorization: Bearer ${secret}"`;
}

export function geminiSettings(endpoint: string, secret: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        ezychat: { httpUrl: endpoint, headers: { Authorization: `Bearer ${secret}` } },
      },
    },
    null,
    2,
  );
}

/** Monospace block that wraps anywhere (never scrolls sideways at 360px) with its own Copy. */
function CodeBlock({
  label,
  code,
  copyLabel,
  testId,
}: {
  label: string;
  code: string;
  copyLabel: string;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p id={id} className="text-sm text-muted-foreground">
        {label}
      </p>
      <pre
        aria-labelledby={id}
        data-testid={testId}
        className="m-0 rounded-md border bg-muted px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
      >
        {code}
      </pre>
      <CopyButton text={code} label={copyLabel} className="self-start" />
    </div>
  );
}

const CLIENTS = ['claude', 'gemini', 'other'] as const;

/**
 * "Connect your assistant": ready-to-paste setup per client. `endpoint` is the full MCP URL; the
 * secret is only ever passed in as a prop from the dialog that created it.
 */
export function TokenConnectSteps({
  endpoint,
  secret,
  localOnly,
}: {
  endpoint: string;
  secret: string;
  localOnly: boolean;
}) {
  const { t } = useTranslation('admin');
  const headingId = useId();
  const label = {
    claude: t('integrations.created.clientClaude'),
    gemini: t('integrations.created.clientGemini'),
    other: t('integrations.created.clientOther'),
  } as const;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <h3 id={headingId} className="text-sm font-medium">
        {t('integrations.created.connect')}
      </h3>
      <Tabs defaultValue="claude" className="min-w-0 gap-3">
        <TabsList aria-labelledby={headingId} className="max-w-full">
          {CLIENTS.map((client) => (
            <TabsTrigger key={client} value={client} className="px-3">
              {label[client]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="claude" className="min-w-0">
          <CodeBlock
            label={t('integrations.created.claudeHint')}
            code={claudeCodeCommand(endpoint, secret)}
            copyLabel={t('integrations.created.copyCommand')}
            testId="mcp-snippet-claude"
          />
        </TabsContent>
        <TabsContent value="gemini" className="min-w-0">
          <CodeBlock
            label={t('integrations.created.geminiHint')}
            code={geminiSettings(endpoint, secret)}
            copyLabel={t('integrations.created.copySettings')}
            testId="mcp-snippet-gemini"
          />
        </TabsContent>
        <TabsContent value="other" className="flex min-w-0 flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t('integrations.created.otherHint')}</p>
          <CodeBlock
            label={t('integrations.created.serverUrl')}
            code={endpoint}
            copyLabel={t('integrations.created.copyUrl')}
            testId="mcp-snippet-url"
          />
          <CodeBlock
            label={t('integrations.created.header')}
            code={`Authorization: Bearer ${secret}`}
            copyLabel={t('integrations.created.copyHeader')}
            testId="mcp-snippet-header"
          />
          <p className="text-sm text-muted-foreground">{t('integrations.created.oauthHint')}</p>
        </TabsContent>
      </Tabs>
      {localOnly && (
        <p className="text-sm text-muted-foreground">{t('integrations.created.localOnly')}</p>
      )}
      <p className="text-sm text-muted-foreground">{t('integrations.created.askHint')}</p>
    </section>
  );
}
