// Contract: every HTTP call the web app makes (api(...) and fetch('/api…') in apps/web/src) matches a
// route the real server registers, with the same method. Unit tests of clients use fakes that answer any
// request, so a wrong method or path passes them and fails only on a real install (Enterprise "Check
// now" sent GET to a POST route). Calls are read from the source with the TypeScript parser; each one is
// sent to the real app, and Fastify's "Route <METHOD> <path> not found" means no route matched.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from './helpers.js';

const WEB_SRC = join(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'src');

export interface ClientCall {
  method: string;
  path: string;
  at: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name) ? [path] : [];
  });
}

/**
 * A string or template literal as concrete paths. `${x}` of a string-literal union type (e.g.
 * 'logout' | 'relink') expands to every value, since each is its own route; any other `${x}` becomes a
 * placeholder segment (a route parameter).
 */
function literalPaths(node: ts.Expression | undefined, checker: ts.TypeChecker): string[] | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (!ts.isTemplateExpression(node)) return null;
  let paths = [node.head.text];
  for (const span of node.templateSpans) {
    const type = checker.getTypeAtLocation(span.expression);
    const parts = type.isUnion() ? type.types : [type];
    const values = parts.every((p) => p.isStringLiteral())
      ? parts.map((p) => (p as ts.StringLiteralType).value)
      : ['p1'];
    paths = paths.flatMap((p) => values.map((v) => p + v + span.literal.text));
  }
  return paths;
}

function property(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name.getText() === name,
  );
}

/** Method of an `api()` or `fetch()` init: literal `method`, else POST with a body/form, else GET. */
function methodOf(init: ts.Expression | undefined, defaultWithBody: string): string | null {
  if (!init) return 'GET';
  if (!ts.isObjectLiteralExpression(init)) return null;
  const m = property(init, 'method');
  if (m) {
    if (ts.isPropertyAssignment(m) && ts.isStringLiteral(m.initializer))
      return m.initializer.text.toUpperCase();
    return null;
  }
  return property(init, 'body') || property(init, 'form') ? defaultWithBody : 'GET';
}

/** Every api()/fetch('/api…') call in the web source; `unresolved` lists calls with a computed path or method. */
export function webClientCalls(): { calls: ClientCall[]; unresolved: string[] } {
  const calls: ClientCall[] = [];
  const unresolved: string[] = [];
  const files = sourceFiles(WEB_SRC);
  const program = ts.createProgram(files, {
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  for (const file of files) {
    const sf = program.getSourceFile(file)!;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        const at = `${relative(WEB_SRC, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        if (callee === 'api' || callee === 'fetch') {
          const raws = literalPaths(node.arguments[0], checker);
          const isApiFetch = callee === 'fetch' && raws?.[0]?.startsWith('/api');
          if (callee === 'api' || isApiFetch) {
            // api() POSTs when a body is given; fetch() keeps GET unless told otherwise.
            const method = methodOf(node.arguments[1], callee === 'api' ? 'POST' : 'GET');
            if (raws === null || method === null) unresolved.push(at);
            else
              for (const raw of raws)
                calls.push({
                  method,
                  path: (callee === 'api' ? '/api' + raw : raw).split('?')[0]!,
                  at,
                });
          } else if (callee === 'fetch' && raws === null) {
            unresolved.push(at);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { calls, unresolved };
}

describe('web client ↔ server routes', () => {
  let t: TestApp;
  // Parsing and type-checking the web source is slow (most of all under coverage): do it once.
  let scan: ReturnType<typeof webClientCalls>;
  beforeAll(async () => {
    scan = webClientCalls();
    t = await makeTestApp();
  }, 60_000);
  afterAll(async () => {
    await t?.close();
  });

  it('finds the web app calls', () => {
    const { calls } = scan;
    expect(calls.length).toBeGreaterThan(60);
  });

  it('checks the New chat calls (docs/features/new-chat/design.md)', () => {
    const ours = scan.calls
      .filter((c) => c.at.startsWith(join('api', 'new-chat.ts')))
      .map((c) => `${c.method} ${c.path.replace(/\/inboxes\/[^/]+\//, '/inboxes/:id/')}`)
      .sort();
    expect(ours).toEqual([
      'GET /api/new-chat',
      'POST /api/inboxes/:id/new-chat',
      'POST /api/inboxes/:id/new-chat/check',
      'PUT /api/new-chat/settings',
    ]);
  });

  it('every web call has a server route with the same method', async () => {
    const { calls } = scan;
    const missing: string[] = [];
    for (const call of calls) {
      const res = await t.app.inject({
        method: call.method as 'GET',
        url: call.path,
        headers: { host: '127.0.0.1', origin: 'http://127.0.0.1' },
        ...(call.method === 'GET' || call.method === 'HEAD' ? {} : { payload: {} }),
      });
      if (res.statusCode === 404 && /"Route \w+ /.test(res.body))
        missing.push(`${call.method} ${call.path}  (${call.at})`);
    }
    expect(missing, 'web calls with no server route').toEqual([]);
  });

  it('every computed call is reviewed (add a literal path, or list it here with a reason)', () => {
    // Calls whose path or method is computed cannot be checked statically.
    const REVIEWED: Record<string, string> = {
      [join('api', 'client.ts')]:
        'the api() helper itself: fetch(`/api${path}`) for every call above',
      [join('lib', 'clipboard.ts')]:
        'copyImageFromUrl: GETs a Message.mediaUrl the server built (GET /api/media/:id, covered by messages.test.ts)',
      [join('lib', 'pdf.ts')]:
        'loadPdf: GETs a Message.mediaUrl the server built (GET /api/media/:id, covered by messages.test.ts and e2e/pdf-viewer.spec.ts)',
    };
    const { unresolved } = scan;
    expect(unresolved.filter((at) => !(at.replace(/:\d+$/, '') in REVIEWED))).toEqual([]);
  });
});
