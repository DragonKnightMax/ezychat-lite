import { chatItem, customerJid, expect, inboxHeading, test } from './helpers';

/** A real two-page PDF (Helvetica text), built with correct xref offsets. */
function twoPagePdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  ];
  const stream = (text: string) => {
    const s = `BT /F1 36 Tf 72 720 Td (${text}) Tj ET`;
    return `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  };
  objects.push(stream('Quotation page one'), stream('Page two'));
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1').toString('base64');
}

test('a customer PDF opens inside the app without saving it first', async ({
  page,
  baseURL,
}, info) => {
  const jid = customerJid(info, 94);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|worker/i.test(m.text()))
      errors.push(m.text());
  });
  await page.goto('/');
  await expect(inboxHeading(page)).toBeVisible();
  const res = await page.request.post('/api/dev/fake-incoming', {
    data: {
      chatJid: jid,
      text: '',
      senderName: 'Tan',
      type: 'document',
      media: { mime: 'application/pdf', fileName: 'Quotation.pdf', base64: twoPagePdf() },
    },
    headers: { Origin: new URL(baseURL!).origin },
  });
  expect(res.status(), await res.text()).toBe(200);
  await chatItem(page, jid).click();

  const log = page.getByRole('log', { name: 'Messages' });
  const download = log.getByRole('link', { name: 'Download Quotation.pdf' });
  await expect(download).toHaveAttribute('download', 'Quotation.pdf');

  await log.getByRole('button', { name: 'Open Quotation.pdf' }).click();
  const viewer = page.getByRole('dialog', { name: 'PDF preview' });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('img', { name: 'Page 1 of 2' })).toBeVisible();
  await expect(viewer.getByRole('img', { name: 'Page 2 of 2' })).toBeAttached();
  // pdf.js drew the first page: its canvas has a bitmap with dark (text) pixels on it.
  await expect
    .poll(() =>
      viewer
        .getByRole('img', { name: 'Page 1 of 2' })
        .locator('canvas')
        .evaluate((c: HTMLCanvasElement) => {
          if (!c.width) return 0;
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let dark = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i]! < 100 && d[i + 3]! > 0) dark++;
          return dark;
        }),
    )
    .toBeGreaterThan(50);

  const firstPage = viewer.getByRole('img', { name: 'Page 1 of 2' });
  const before = (await firstPage.boundingBox())!.width;
  await viewer.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await firstPage.boundingBox())!.width).toBeGreaterThan(before);

  await viewer.getByRole('button', { name: 'Close' }).click();
  await expect(viewer).toBeHidden();
  // Opening it again loads it again.
  await log.getByRole('button', { name: 'Open Quotation.pdf' }).click();
  await expect(viewer.getByRole('img', { name: 'Page 2 of 2' })).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  expect(errors).toEqual([]);
});
