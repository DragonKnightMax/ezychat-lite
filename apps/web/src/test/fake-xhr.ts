// A stand-in XMLHttpRequest for upload tests (apiUpload): it reports progress, then answers.
import { vi } from 'vitest';

export interface FakeUpload {
  url: string;
  form: FormData;
}

type Answer = { status: number; body?: unknown } | 'network-error';

/**
 * Replaces XMLHttpRequest: every send reports half and all of the upload, then `answer` decides the
 * reply (a JSON body, a text body, or a network error). Returns the uploads made.
 */
export function stubXhr(answer: (upload: FakeUpload) => Answer): FakeUpload[] {
  const uploads: FakeUpload[] = [];
  class FakeXhr {
    upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    withCredentials = false;
    status = 0;
    statusText = '';
    responseText = '';
    private url = '';
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    send(form: FormData) {
      const made = { url: this.url, form };
      uploads.push(made);
      queueMicrotask(() => {
        for (const loaded of [5, 10])
          this.upload.onprogress?.({ lengthComputable: true, loaded, total: 10 } as ProgressEvent);
        const a = answer(made);
        if (a === 'network-error') return this.onerror?.();
        this.status = a.status;
        this.responseText =
          typeof a.body === 'string' ? a.body : a.body === undefined ? '' : JSON.stringify(a.body);
        this.onload?.();
      });
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return uploads;
}
