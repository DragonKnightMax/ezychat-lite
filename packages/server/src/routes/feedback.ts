import type { FastifyInstance } from 'fastify';
import {
  FEEDBACK_MAX_FILE_BYTES,
  FEEDBACK_MAX_FILES,
  FEEDBACK_MAX_TOTAL_BYTES,
  FeedbackReportBody,
  type FeedbackDefaults,
  type FeedbackSentResponse,
} from '@ezychat/shared';
import { requireUser } from '../auth/guards.js';
import type { AppContext } from '../context.js';
import { feedbackFileName, feedbackFileType } from '../feedback/files.js';
import type { PortalFile } from '../feedback/portal.js';
import { getFeedback } from '../feedback/service.js';
import { errors, HttpError, parse } from '../http/errors.js';

const tooLarge = () => new HttpError(413, 'too_large', 'The files are too large to send');
const badType = () => new HttpError(415, 'file_type', 'This kind of file cannot be attached');

/** Send feedback (docs/features/in-app-feedback/design.md): anyone signed in. */
export default async function feedbackRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', requireUser(ctx));

  app.get('/feedback/defaults', async (): Promise<FeedbackDefaults> => getFeedback(ctx).defaults());

  app.post('/feedback', async (req, reply) => {
    if (!req.isMultipart()) throw errors.validation('Expected multipart/form-data');
    let raw: string | null = null;
    const files: PortalFile[] = [];
    let total = 0;
    try {
      for await (const part of req.parts({
        limits: {
          files: FEEDBACK_MAX_FILES,
          fileSize: FEEDBACK_MAX_FILE_BYTES,
          fields: 5,
          fieldSize: 64 * 1024,
        },
      })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') {
            part.file.resume();
            continue;
          }
          const bytes = await part.toBuffer();
          total += bytes.length;
          if (total > FEEDBACK_MAX_TOTAL_BYTES) throw tooLarge();
          const type = feedbackFileType(bytes, part.filename ?? '');
          if (!type) throw badType();
          files.push({ name: feedbackFileName(part.filename ?? '', type), type, bytes });
        } else if (part.fieldname === 'report' && typeof part.value === 'string') {
          raw = part.value;
        }
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const code = (err as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge();
      if (code === 'FST_FILES_LIMIT')
        throw errors.validation(`At most ${FEEDBACK_MAX_FILES} files`);
      throw err;
    }
    if (raw === null) throw errors.validation('report is required');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw errors.validation('report must be JSON');
    }
    const report = parse(FeedbackReportBody, json);
    const reference = await getFeedback(ctx).send(req.user!.id, report, files);
    const body: FeedbackSentResponse = { reference };
    return reply.status(201).send(body);
  });
}
