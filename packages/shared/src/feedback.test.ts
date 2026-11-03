import { describe, expect, it } from 'vitest';
import {
  FEEDBACK_AREAS,
  FeedbackDefaults,
  FeedbackDiagnostics,
  FeedbackReportBody,
  FeedbackSentResponse,
} from './feedback.js';

const report = {
  clientReportId: '7b0e6a52-5f1c-4c39-9f43-5f0d3b6f1a2e',
  type: 'problem',
  title: 'Photos do not open',
  details: 'Customer photos stay grey since this morning.',
  area: 'inbox',
  name: 'Aisyah',
  email: 'aisyah@example.com',
  contactOk: true,
  includeDetails: true,
  includeLog: false,
  client: 'browser',
};

describe('Feedback contract', () => {
  it('accepts a minimal report and fills the defaults', () => {
    const parsed = FeedbackReportBody.parse(report);
    expect(parsed).toMatchObject({ screen: '/', language: '', timeZone: '' });
  });

  it('trims and checks the lengths of title, details, name and email', () => {
    expect(FeedbackReportBody.parse({ ...report, title: '  Hi!  ' }).title).toBe('Hi!');
    expect(FeedbackReportBody.safeParse({ ...report, title: 'Hi' }).success).toBe(false);
    expect(FeedbackReportBody.safeParse({ ...report, title: 'x'.repeat(121) }).success).toBe(false);
    expect(FeedbackReportBody.safeParse({ ...report, details: 'too short' }).success).toBe(false);
    expect(FeedbackReportBody.safeParse({ ...report, details: 'x'.repeat(5001) }).success).toBe(
      false,
    );
    expect(FeedbackReportBody.safeParse({ ...report, name: '  ' }).success).toBe(false);
    expect(FeedbackReportBody.safeParse({ ...report, email: '' }).success).toBe(false);
    expect(FeedbackReportBody.safeParse({ ...report, email: 'not-an-email' }).success).toBe(false);
  });

  it('takes how often and how bad only for a problem', () => {
    expect(
      FeedbackReportBody.parse({ ...report, frequency: 'once', impact: 'blocking' }),
    ).toMatchObject({ frequency: 'once', impact: 'blocking' });
    expect(FeedbackReportBody.safeParse({ ...report, type: 'idea', impact: 'minor' }).success).toBe(
      false,
    );
    expect(FeedbackReportBody.safeParse({ ...report, type: 'idea' }).success).toBe(true);
  });

  it('uses the licence portal area codes and refuses unknown fields', () => {
    expect(FEEDBACK_AREAS).toEqual([
      'inbox',
      'ai_agent',
      'whatsapp_link',
      'connectors',
      'reports',
      'settings',
      'install_update',
      'other',
    ]);
    expect(FeedbackReportBody.safeParse({ ...report, area: 'ai' }).success).toBe(false);
    expect(FeedbackReportBody.safeParse({ ...report, product: 'EZC-ENT' }).success).toBe(false);
    expect(FeedbackReportBody.safeParse({ ...report, clientReportId: 'x' }).success).toBe(false);
  });

  it('reads the defaults, the diagnostics and the reference', () => {
    const diagnostics = {
      edition: 'lite',
      version: '0.1.73',
      os: 'Windows 11',
      osVersion: '10.0.26100',
      mode: 'standalone',
      waConnected: true,
      aiMode: 'off',
    };
    expect(
      FeedbackDefaults.parse({ company: null, logLines: 0, logPreview: '', diagnostics }),
    ).toMatchObject({ company: null });
    expect(
      FeedbackDiagnostics.safeParse({
        ...diagnostics,
        client: 'desktop',
        language: 'en',
        timeZone: 'Asia/Kuala_Lumpur',
        screen: '/admin/reports',
      }).success,
    ).toBe(true);
    expect(FeedbackSentResponse.parse({ reference: 'FB-0043' })).toEqual({ reference: 'FB-0043' });
    expect(FeedbackSentResponse.safeParse({ reference: '' }).success).toBe(false);
  });
});
