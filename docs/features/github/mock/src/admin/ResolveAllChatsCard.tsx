import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { useOpenChatCount, useResolveAllChats } from '../api/queries';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog, ErrorState } from './adminUi';

export function ResolveAllChatsCard() {
  const count = useOpenChatCount();
  const resolve = useResolveAllChats();
  const [confirming, setConfirming] = useState(false);
  const { t } = useTranslation('admin');
  const openCount = count.data?.openCount;

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t('resolveAll.title')}</CardTitle>
        <CardDescription>{t('resolveAll.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-3">
        {count.isError ? (
          <ErrorState error={count.error} onRetry={() => void count.refetch()} />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {openCount === undefined
              ? t('resolveAll.loading')
              : openCount === 0
                ? t('resolveAll.none')
                : t('resolveAll.openCount', { count: openCount })}
          </p>
        )}
        <Button
          variant="outline"
          size="touch"
          className="w-full sm:w-auto md:min-h-9"
          disabled={count.isPending || count.isError || !openCount || resolve.isPending}
          onClick={() => {
            resolve.reset();
            setConfirming(true);
          }}
        >
          {t('resolveAll.button')}
        </Button>
        <ConfirmDialog
          open={confirming}
          title={t('resolveAll.confirmTitle')}
          confirmLabel={t('resolveAll.confirm')}
          loading={resolve.isPending}
          error={resolve.error ?? undefined}
          onClose={() => setConfirming(false)}
          onConfirm={() =>
            resolve.mutate(undefined, {
              onSuccess: ({ resolvedCount }) => {
                toast.success(
                  resolvedCount === 0
                    ? t('resolveAll.none')
                    : t('resolveAll.done', { count: resolvedCount }),
                );
                setConfirming(false);
              },
            })
          }
        >
          <p>
            {openCount === undefined
              ? t('resolveAll.confirmBody')
              : t('resolveAll.confirmBodyWithCount', { openCount })}
          </p>
        </ConfirmDialog>
      </CardContent>
    </Card>
  );
}
