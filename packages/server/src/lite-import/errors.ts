/** A check refused the import before anything changed (CLI exit 5, outcome `{ error: { code } }`). */
export type LiteImportRefusedCode =
  'lite_newer' | 'same_number' | 'no_slot' | 'disk' | 'lite_running';

export class LiteImportRefused extends Error {
  constructor(readonly code: LiteImportRefusedCode) {
    super(`lite import refused: ${code}`);
    this.name = 'LiteImportRefused';
  }
}

/** The folder has no Lite data (no app.db): CLI exit 2. */
export class NoLiteDataError extends Error {
  readonly code = 'no_lite_data' as const;
  constructor(dir: string) {
    super(`no EzyChat Lite data in ${dir} (app.db missing)`);
    this.name = 'NoLiteDataError';
  }
}
