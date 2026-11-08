/**
 * The file types the MCP send tools and uploads accept, read from the bytes (never a label, header or
 * name), with the extension each is sent with. One table, so an upload, a link and base64 always agree.
 */

/** Images WhatsApp shows as a photo (send_image). */
export const MCP_IMAGE_TYPES: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

/** Documents send_file accepts. */
export const MCP_FILE_TYPES: ReadonlyMap<string, string> = new Map([
  ['application/pdf', 'pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
]);

/** Videos send_video accepts. */
export const MCP_VIDEO_TYPES: ReadonlyMap<string, string> = new Map([['video/mp4', 'mp4']]);

/** Everything POST /mcp/uploads accepts. */
export const MCP_UPLOAD_TYPES: ReadonlyMap<string, string> = new Map([
  ...MCP_IMAGE_TYPES,
  ...MCP_FILE_TYPES,
  ...MCP_VIDEO_TYPES,
]);
