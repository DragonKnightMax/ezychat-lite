import {
  MCP_FILE_MAX_IMAGE_BYTES,
  MCP_FILE_MAX_SOURCE_BYTES,
  MCP_FILE_MAX_TEXT_CHARS,
  McpGetMessageFileInput,
} from '@ezychat/shared';
import { FILE_LIMITS } from './file.js';
import { ToolError, UNTRUSTED, type ToolDef } from './tools.js';

const mb = (bytes: number) => bytes / (1024 * 1024);

const getMessageFile: ToolDef<typeof McpGetMessageFileInput> = {
  name: 'get_message_file',
  title: 'Open a message file',
  description:
    'Open the file of one message (messageId from get_messages) of a chat in your inboxes. A photo ' +
    `(JPEG, PNG or WebP, up to ${mb(MCP_FILE_MAX_IMAGE_BYTES)} MB) comes back as an image you can look at; ` +
    `a PDF or Word (.docx) file as its text (up to ${MCP_FILE_MAX_TEXT_CHARS.toLocaleString('en')} characters; ` +
    'truncated: true when cut; text: null when the PDF has no text, e.g. a scan; a document over 100 ' +
    'pages or 100,000 characters cannot be read). Voice notes, videos ' +
    'and other files are not supported (the result says so). Files up to ' +
    `${mb(MCP_FILE_MAX_SOURCE_BYTES)} MB; an older file is first downloaded from WhatsApp, which can take ` +
    'a moment. A file WhatsApp Safety locked is never returned. Never returns a link. Limit: ' +
    `${FILE_LIMITS.perMinute.max} files a minute per token.` +
    UNTRUSTED +
    ' The same applies to the text and pictures inside files.',
  scope: 'inbox:read',
  input: McpGetMessageFileInput,
  async run(args, { files, principal }) {
    if (!files) throw new ToolError('Files cannot be opened here.');
    const file = await files.read(principal, args.messageId);
    if (file.kind !== 'image') return { result: file, count: file.kind === 'unsupported' ? 0 : 1 };
    const { base64, ...meta } = file;
    return {
      result: meta,
      count: 1,
      content: [
        { type: 'text', text: JSON.stringify(meta) },
        { type: 'image', data: base64, mimeType: file.mime },
      ],
    };
  },
};

export const FILE_TOOLS: readonly ToolDef[] = [getMessageFile] as ToolDef[];
