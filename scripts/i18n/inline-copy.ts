/**
 * Finds user-facing copy that is still written inline rather than read from a
 * message catalog.
 *
 * Both finders are heuristics: they feed the burndown in the copy inventory,
 * where a close count is enough. They return the matched strings rather than
 * a number so a surprising count can be checked by eye.
 */

import { readFileSync } from 'node:fs';

import ts from 'typescript';

const ACCENTED = /[áàâãéêíóôõúçÁÉÍÓÚÂÊÔÃÕÇ]/;

/** Material Symbols ligature names, such as `confirmation_number`. */
const ICON_LIGATURE = /^[a-z_]+$/;

const HUMAN_ATTRIBUTES =
  /\b(?:placeholder|aria-label|title|alt|label)="([^"]*)"/g;

/**
 * Inline text in an EJS template: text between tags that contains a letter,
 * and the values of attributes a person reads or hears.
 *
 * EJS tags, HTML comments, `<script>` and `<style>` blocks and HTML entities
 * are removed first, so output tags and inlined JSON do not count.
 *
 * @param source - The template.
 */
export const findTemplateCopy = (source: string): string[] => {
  const markup = source
    .replace(/<%[\s\S]*?%>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ');

  const texts = [...markup.matchAll(/>([^<>]+)</g)]
    .map((match) => (match[1] ?? '').replace(/\s+/g, ' ').trim())
    .filter((text) => /\p{L}/u.test(text) && !ICON_LIGATURE.test(text));

  const attributes = [...markup.matchAll(HUMAN_ATTRIBUTES)]
    .map((match) => (match[1] ?? '').trim())
    .filter((value) => /\p{L}/u.test(value));

  return [...texts, ...attributes];
};

/** Calls whose string arguments are diagnostics or DOM plumbing, not copy. */
const NON_COPY_CALLEE =
  /^(?:logger|console)\.|Error$|(?:^|\.)(?:qs|qsOptional|querySelector|querySelectorAll|getElementById|closest|matches|addEventListener|removeEventListener|setAttribute|getAttribute|removeAttribute|toggle|add|remove|contains)$/;

/**
 * Reports whether a literal reads as prose: it carries a Portuguese accent, or
 * starts with a capitalised word.
 */
const isProse = (text: string): boolean =>
  ACCENTED.test(text) || /^[A-Z][a-z]+(?:[\s.,!?…]|$)/.test(text);

/** Walks out of the expressions a literal can sit inside to the call, if any. */
const enclosingCall = (
  node: ts.Node,
): ts.CallExpression | ts.NewExpression | undefined => {
  let current = node.parent;

  while (
    ts.isConditionalExpression(current) ||
    ts.isBinaryExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTemplateSpan(current) ||
    ts.isTemplateExpression(current)
  ) {
    current = current.parent;
  }

  return ts.isCallExpression(current) || ts.isNewExpression(current)
    ? current
    : undefined;
};

const isComparison = (node: ts.Node): boolean => {
  const parent = node.parent;

  return (
    ts.isBinaryExpression(parent) &&
    [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(parent.operatorToken.kind)
  );
};

/**
 * Inline prose in a client module: string and template literals that read as
 * prose and are not imports, property keys, types, comparison operands, or
 * arguments to logging, error constructors and DOM plumbing.
 *
 * @param file - Path to a `.ts` file.
 */
export const findClientCopy = (file: string): string[] => {
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isTypeNode(node)) return;

    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const parent = node.parent;
      const isKey =
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isElementAccessExpression(parent) &&
          parent.argumentExpression === node);
      const call = enclosingCall(node);
      const callee = call ? call.expression.getText(sourceFile) : '';

      if (
        !isKey &&
        !isComparison(node) &&
        !NON_COPY_CALLEE.test(callee) &&
        isProse(node.text)
      ) {
        found.push(node.text);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return found;
};
