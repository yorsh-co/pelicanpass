/**
 * Fails when client code writes inline text to the page instead of reading it
 * from a message catalog.
 *
 * Inspects every sink that puts text in front of a person — `textContent`,
 * `innerText`, `innerHTML`, `placeholder`, `ariaLabel`, `title` and `alt`
 * assignments; `setAttribute` for `aria-label`, `title`, `placeholder` and
 * `alt`; `confirm`, `alert`, `toast.<level>`, `new Toast` and the
 * `hint.showHint` / `showError` / `change` / `set` helpers — and flags a value
 * that is, or branches to, a string or template literal carrying a letter.
 * Identifiers, calls and property reads pass: they are where a message
 * accessor's result arrives. Language-agnostic, unlike the lint rule for
 * accented literals.
 *
 * A sink that must write a literal — an icon ligature, say — is exempted by a
 * `/* copy-ok: <reason> *\/` comment before its statement. The reason is
 * required.
 *
 * Syntactic by design: a literal that reaches a sink through a variable or a
 * default parameter is not seen. The accented-literal lint rule covers most of
 * that gap for pt-BR.
 *
 * Skipped: `core/`, the API transport, whose strings are diagnostics.
 *
 * Usage:
 *   node scripts/i18n/audit-strings.ts
 */

import { globSync, readFileSync } from 'node:fs';

import ts from 'typescript';

import { ROOT } from './generate.ts';

const CLIENT_DIR = `${ROOT}src/web/client`;
const EXCLUDED = ['core/**'];

const TEXT_PROPERTIES = new Set([
  'textContent',
  'innerText',
  'innerHTML',
  'placeholder',
  'ariaLabel',
  'title',
  'alt',
]);

const TEXT_ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt']);

/** Callees whose first argument is shown as text. */
const FIRST_ARGUMENT_SINK =
  /^(?:window\.)?(?:confirm|alert)$|(?:^|\.)toast\.(?:debug|info|warn|error)$/;

/** Callees whose second argument is shown as text. */
const SECOND_ARGUMENT_SINK = /(?:^|\.)hint\.(?:showHint|showError|change)$/;

/** The `hint.set(el, { text })` helper, whose `text` option is shown. */
const OPTIONS_SINK = /(?:^|\.)hint\.set$/;

const COPY_OK = /^\/\*\s*copy-ok:(.*?)\*\/$/s;

/** One sink that writes a literal. */
interface Violation {
  file: string;
  line: number;
  sink: string;
  text: string;
}

/**
 * The literals an expression can evaluate to, looking through parentheses,
 * conditional branches and logical operands.
 *
 * @param node - The value written to a sink.
 */
const literalsIn = (node: ts.Expression): string[] => {
  if (ts.isParenthesizedExpression(node)) return literalsIn(node.expression);

  if (ts.isConditionalExpression(node)) {
    return [...literalsIn(node.whenTrue), ...literalsIn(node.whenFalse)];
  }

  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.PlusToken,
    ].includes(node.operatorToken.kind)
  ) {
    return [...literalsIn(node.left), ...literalsIn(node.right)];
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }

  if (ts.isTemplateExpression(node)) {
    return [
      [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
        .join('${…}')
        .trim(),
    ];
  }

  return [];
};

/** Whether a literal's text would read as words rather than punctuation. */
const hasLetter = (text: string): boolean => /\p{L}/u.test(text);

/**
 * The statement a sink belongs to, where a `copy-ok` comment is looked for.
 *
 * @param node - The sink expression.
 */
const statementOf = (node: ts.Node): ts.Node => {
  let current = node;

  while (!ts.isStatement(current) && !ts.isSourceFile(current)) {
    current = current.parent;
  }

  return current;
};

/**
 * The reason given by a `copy-ok` comment before the statement, `''` for a
 * marker without one, or `undefined` when there is no marker.
 *
 * @param statement - The sink's statement.
 * @param source - The file's text.
 */
const copyOkReason = (
  statement: ts.Node,
  source: string,
): string | undefined => {
  const ranges =
    ts.getLeadingCommentRanges(source, statement.getFullStart()) ?? [];

  for (const range of ranges) {
    const match = COPY_OK.exec(source.slice(range.pos, range.end));

    if (match) return (match[1] ?? '').trim();
  }

  return undefined;
};

/**
 * Checks every sink in one file.
 *
 * @param file - Path relative to src/web/client.
 * @returns The violations, and how many sinks were inspected.
 */
const auditFile = (
  file: string,
): { violations: Violation[]; sinks: number } => {
  const source = readFileSync(`${CLIENT_DIR}/${file}`, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  const violations: Violation[] = [];
  let sinks = 0;

  const check = (sink: string, value: ts.Expression | undefined): void => {
    if (!value) return;

    sinks += 1;

    const texts = literalsIn(value).filter(hasLetter);
    const statement = statementOf(value);
    const reason = copyOkReason(statement, source);
    const line =
      sourceFile.getLineAndCharacterOfPosition(value.getStart()).line + 1;

    if (reason === '') {
      violations.push({ file, line, sink, text: 'copy-ok without a reason' });
      return;
    }

    if (reason !== undefined) return;

    for (const text of texts) violations.push({ file, line, sink, text });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      TEXT_PROPERTIES.has(node.left.name.text)
    ) {
      check(`.${node.left.name.text}`, node.right);
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(sourceFile);
      const [first, second] = node.arguments;

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'setAttribute' &&
        first &&
        ts.isStringLiteral(first) &&
        TEXT_ATTRIBUTES.has(first.text)
      ) {
        check(`setAttribute('${first.text}')`, second);
      } else if (FIRST_ARGUMENT_SINK.test(callee)) {
        check(callee, first);
      } else if (SECOND_ARGUMENT_SINK.test(callee)) {
        check(callee, second);
      } else if (
        OPTIONS_SINK.test(callee) &&
        second &&
        ts.isObjectLiteralExpression(second)
      ) {
        const text = second.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(sourceFile) === 'text',
        );

        check(`${callee}({ text })`, text?.initializer);
      }
    }

    if (
      ts.isNewExpression(node) &&
      node.expression.getText(sourceFile) === 'Toast'
    ) {
      check('new Toast', node.arguments?.[1]);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return { violations, sinks };
};

const files = globSync('**/*.ts', {
  cwd: CLIENT_DIR,
  exclude: EXCLUDED,
}).sort();
const results = files.map(auditFile);
const violations = results.flatMap((result) => result.violations);
const sinks = results.reduce((total, result) => total + result.sinks, 0);

if (violations.length > 0) {
  for (const { file, line, sink, text } of violations) {
    console.error(
      `copy: src/web/client/${file}:${String(line)}  ${sink}  ${JSON.stringify(text)}`,
    );
  }

  console.error(
    'copy: read the text from a message catalog, or mark a deliberate literal with /* copy-ok: <reason> */; see docs/development/copy-management.md',
  );
  process.exit(1);
}

console.log(
  `✓ copy audit passed (${String(sinks)} sinks in ${String(files.length)} files)`,
);
