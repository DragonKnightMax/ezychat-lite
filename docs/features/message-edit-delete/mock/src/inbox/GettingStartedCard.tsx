import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bot, ChevronRight, Smartphone, Users, X } from 'lucide-react';
import { useAiMember } from '../api/ai';
import { useMe, useTunnel, useUsers } from '../api/queries';
import { memberPill } from '../admin/ai-status';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const HIDDEN_KEY = 'ezychat.mock.getting-started-hidden';

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * PROPOSED: a small "Getting started" card on the empty inbox (admins only). Lists what is left
 * (AI assistant, teammates, phone access), links each to its admin page and hides finished items.
 */
export function GettingStartedCard({ className }: { className?: string }) {
  const me = useMe();
  return me.data?.role === 'admin' ? <AdminChecklist className={className} /> : null;
}

function AdminChecklist({ className }: { className?: string }) {
  const { t } = useTranslation('admin');
  const ai = useAiMember();
  const users = useUsers();
  const tunnel = useTunnel();
  const titleId = useId();
  const [hidden, setHidden] = useState(readHidden);
  if (hidden || !ai.data || !users.data || !tunnel.data) return null;

  const humans = users.data.filter((user) => user.kind !== 'ai' && !user.disabled);
  const items = [
    {
      key: 'ai',
      done: memberPill(ai.data) === 'on',
      icon: Bot,
      title: t('mockSetup.started.ai'),
      hint: t('mockSetup.started.aiHint'),
      action: t('mockSetup.started.setUp'),
      to: '/admin/members/ai',
    },
    {
      key: 'team',
      done: humans.length > 1,
      icon: Users,
      title: t('mockSetup.started.teammates'),
      hint: t('mockSetup.started.teammatesHint'),
      action: t('mockSetup.started.add'),
      to: '/admin/members',
    },
    {
      key: 'phone',
      done: tunnel.data.state === 'running',
      icon: Smartphone,
      title: t('mockSetup.started.phone'),
      hint: t('mockSetup.started.phoneHint'),
      action: t('mockSetup.started.setUp'),
      to: '/admin/tunnel',
    },
  ].filter((item) => !item.done);
  if (items.length === 0) return null;

  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(HIDDEN_KEY, '1');
    } catch {
      /* storage unavailable: hidden for this visit only */
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      className={cn('w-full max-w-md rounded-lg border bg-card text-left shadow-xs', className)}
    >
      <div className="flex items-center gap-2 border-b py-1 pr-1 pl-4">
        <h2 id={titleId} className="text-sm font-semibold whitespace-nowrap">
          {t('mockSetup.started.title')}
        </h2>
        <Badge variant="outline">{t('mockSetup.proposed')}</Badge>
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          className="ml-auto text-muted-foreground"
          aria-label={t('mockSetup.started.hide')}
          title={t('mockSetup.started.hide')}
          onClick={hide}
        >
          <X aria-hidden />
        </Button>
      </div>
      <ul className="divide-y">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              to={item.to}
              className="flex min-h-14 items-center gap-3 px-4 py-2.5 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <item.icon className="size-4" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{item.title}</span>
                <span className="block text-sm text-muted-foreground">{item.hint}</span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-0.5 text-sm font-medium text-primary">
                {item.action}
                <ChevronRight className="size-4" aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
