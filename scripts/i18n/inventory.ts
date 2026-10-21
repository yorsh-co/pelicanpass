/**
 * Writes docs/development/copy-inventory.md: every catalog message, screen by screen, in a
 * form a non-developer can review and quote, plus appendices for the copy that
 * is not in a catalog yet or lives elsewhere.
 *
 * The output is deterministic and committed. `--check` fails when the
 * committed document differs from what would be written, so a change to a
 * catalog or to inline copy has to regenerate it.
 *
 * Usage:
 *   node scripts/i18n/inventory.ts            write the document
 *   node scripts/i18n/inventory.ts --check    fail if it is stale
 */

import { existsSync, globSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

import {
  isPluralElement,
  isSelectElement,
  isTagElement,
  parse,
} from '@formatjs/icu-messageformat-parser';
import { IntlMessageFormat } from 'intl-messageformat';

import { WHATSAPP_TEMPLATES } from '../../src/constants/whatsapp-templates.ts';
import { BASE_LOCALE, LOCALES, PSEUDO_LOCALE } from '../../src/i18n/locales.ts';
import { NAMESPACES } from '../../src/i18n/namespaces.ts';
import {
  MESSAGES_DIR,
  ROOT,
  collectArguments,
  readCatalog,
} from './generate.ts';
import { findClientCopy, findTemplateCopy } from './inline-copy.ts';

import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import type { PrimitiveType } from 'intl-messageformat';

import type { Namespace } from '../../src/i18n/namespaces.ts';
import type { ArgumentType, SourceMessage } from './generate.ts';

// Sample dates render in the process timezone; pinning it keeps the document
// identical across machines.
process.env.TZ = 'UTC';

const OUTPUT = `${ROOT}docs/development/copy-inventory.md`;
const VIEWS_DIR = `${ROOT}src/web/views`;
const CLIENT_DIR = `${ROOT}src/web/client`;

const SAMPLE_NUMBER = 9999;
const SAMPLE_PLURALS = [0, 1, 2];
const SAMPLE_DATE = new Date(Date.UTC(2026, 8, 13, 18, 30));

interface Message {
  ns: Namespace;
  id: string;
  source: SourceMessage;
  args: Map<string, ArgumentType>;
  /** Arguments that select a plural form, as opposed to plain numbers. */
  plurals: string[];
  branches: boolean;
  format: IntlMessageFormat;
}

type Values = Record<string, PrimitiveType>;

/** Names of every plural argument in a message, and whether it branches at all. */
const branchesOf = (
  elements: MessageFormatElement[],
  plurals = new Set<string>(),
): { plurals: Set<string>; branches: boolean } => {
  let branches = false;

  for (const element of elements) {
    if (isPluralElement(element)) plurals.add(element.value);

    if (isPluralElement(element) || isSelectElement(element)) {
      branches = true;
      for (const option of Object.values(element.options)) {
        branchesOf(option.value, plurals);
      }
    } else if (isTagElement(element)) {
      branches = branchesOf(element.children, plurals).branches || branches;
    }
  }

  return { plurals, branches };
};

const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** Escapes the characters Markdown would otherwise interpret in body text. */
const escapeMarkdown = (text: string): string =>
  text.replace(/[\\`*_[\]<>|]/g, (char) => `\\${char}`);

/** A code span that survives backticks inside the text. */
const code = (text: string): string =>
  text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``;

/** One sentence per line, indented to continue a list item. */
const sentences = (text: string, indent: string): string =>
  text
    .trim()
    .split(/(?<=[.!?])\s+(?=\S)/)
    .join(`\n${indent}`);

/** GitHub's heading anchor for a heading's text. */
const anchor = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');

const heading = (message: Message): string =>
  `${message.ns} · ${message.id
    .slice(message.ns.length + 1)
    .split('.')
    .join(' · ')}`;

/** Sample values: numbers are large, strings name their argument. */
const baseValues = (args: Map<string, ArgumentType>): Values =>
  Object.fromEntries(
    [...args].map(([name, type]): [string, PrimitiveType] => {
      if (type === 'number') return [name, SAMPLE_NUMBER];
      if (type === 'Date') return [name, SAMPLE_DATE];
      if (type === 'string') return [name, `‹${name}›`];
      return [name, type.cases[0] ?? ''];
    }),
  );

const render = (message: Message, values: Values): string =>
  message.format.format<string>(values) as string;

/** Each select argument in turn at each of its cases, the rest at their base. */
const selectVariants = (message: Message): Values[] => {
  const base = baseValues(message.args);
  const variants = [...message.args].flatMap(([name, type]) =>
    typeof type === 'string'
      ? []
      : type.cases.map((value) => ({ ...base, [name]: value })),
  );

  return variants.length > 0 ? variants : [base];
};

const localeStatus = (
  message: Message,
  translatable: boolean,
  translations: Map<string, Set<string>>,
): string =>
  LOCALES.map((locale) => {
    if (locale === BASE_LOCALE) return `${locale} ✓`;
    if (!translatable) return `${locale} not translated`;
    if (locale === PSEUDO_LOCALE) return `${locale} (pseudo)`;

    return translations.get(`${locale}/${message.ns}`)?.has(message.id)
      ? `${locale} ✓`
      : `${locale} missing — serves ${BASE_LOCALE}`;
  }).join(' · ');

const renderMessage = (
  message: Message,
  translatable: boolean,
  translations: Map<string, Set<string>>,
): string =>
  [
    `### ${heading(message)}`,
    '',
    `> ${escapeMarkdown(message.source.defaultMessage)}`,
    '',
    `- **Why:** ${sentences(escapeMarkdown(message.source.description), '  ')}`,
    `- **Ref:** ${code(message.id)}`,
    `- **Locales:** ${localeStatus(message, translatable, translations)}`,
  ].join('\n');

const duplicatesAppendix = (messages: Message[]): string => {
  const byText = new Map<string, string[]>();

  for (const message of messages) {
    const ids = byText.get(message.source.defaultMessage) ?? [];
    ids.push(message.id);
    byText.set(message.source.defaultMessage, ids);
  }

  const groups = [...byText]
    .filter(([, ids]) => ids.length > 1)
    .sort(([a], [b]) => byCodeUnit(a, b));

  const intro = [
    'Identical wording under more than one Ref.',
    'Share a message only when a single wording decision would necessarily change every occurrence; otherwise they are two messages that happen to be spelled alike.',
  ].join('\n');

  const body =
    groups.length === 0
      ? 'None.'
      : groups
          .map(
            ([text, ids]) =>
              `- ${escapeMarkdown(text)}: ${ids.sort(byCodeUnit).map(code).join(', ')}`,
          )
          .join('\n');

  return `## Appendix A — Duplicates\n\n${intro}\n\n${body}`;
};

const pluralSelectAppendix = (messages: Message[]): string => {
  const branching = messages.filter((message) => message.branches);

  const sections = branching.map((message) => {
    const { plurals } = message;
    const lines = new Set<string>();

    for (const variant of selectVariants(message)) {
      const counts = plurals.length > 0 ? SAMPLE_PLURALS : [undefined];

      for (const count of counts) {
        const values: Values = { ...variant };
        for (const name of plurals) values[name] = count;

        const label = Object.entries(values)
          .filter(([name]) => message.args.get(name) !== 'string')
          .map(([name, value]) => `${name}=${String(value)}`)
          .join(', ');

        lines.add(`- ${label} → ${escapeMarkdown(render(message, values))}`);
      }
    }

    return [
      `### ${code(message.id)}`,
      '',
      `ICU: ${code(message.source.defaultMessage)}`,
      '',
      ...lines,
    ].join('\n');
  });

  return [
    '## Appendix B — Plural and select messages',
    '',
    'Each message rendered in pt-BR for sample values.',
    'In pt-BR, the plural category `one` covers both 0 and 1.',
    '',
    sections.length > 0 ? sections.join('\n\n') : 'None.',
  ].join('\n');
};

const longestAppendix = (messages: Message[]): string => {
  const rows = NAMESPACES.flatMap(({ name: ns }) => {
    let longest: { id: string; text: string } | undefined;

    for (const message of messages.filter((m) => m.ns === ns)) {
      for (const values of selectVariants(message)) {
        const text = render(message, values);
        if (!longest || text.length > longest.text.length) {
          longest = { id: message.id, text };
        }
      }
    }

    return longest
      ? [
          `| ${ns} | ${code(longest.id)} | ${String(longest.text.length)} | ${escapeMarkdown(longest.text)} |`,
        ]
      : [];
  });

  return [
    '## Appendix C — Longest message per screen',
    '',
    'The layout stress case for each screen.',
    `Rendered with numbers at ${String(SAMPLE_NUMBER)}, text arguments as ‹name›, and every select case tried.`,
    '',
    '| Screen | Ref | Characters | Rendered |',
    '| --- | --- | ---: | --- |',
    ...rows,
  ].join('\n');
};

const countTable = (
  title: string,
  counts: [string, number][],
  total: number,
): string =>
  [
    `### ${title}`,
    '',
    '| File | Strings |',
    '| --- | ---: |',
    ...counts.map(([file, count]) => `| ${code(file)} | ${String(count)} |`),
    `| **Total** | **${String(total)}** |`,
  ].join('\n');

const notMigratedAppendix = (): string => {
  const templates = globSync('**/*.ejs', { cwd: VIEWS_DIR })
    .sort(byCodeUnit)
    .map((file): [string, number] => [
      file,
      findTemplateCopy(readFileSync(`${VIEWS_DIR}/${file}`, 'utf8')).length,
    ])
    .filter(([, count]) => count > 0);

  // core/ is the API transport: its strings are diagnostics and operation
  // labels, never shown as copy. demo/ is the static demo's fictional data
  // and mock API, which production never bundles.
  const client = globSync('**/*.ts', { cwd: CLIENT_DIR })
    .filter((file) => !file.startsWith('core/') && !file.startsWith('demo/'))
    .sort(byCodeUnit)
    .map((file): [string, number] => [
      file,
      findClientCopy(`${CLIENT_DIR}/${file}`).length,
    ])
    .filter(([, count]) => count > 0);

  const sum = (rows: [string, number][]): number =>
    rows.reduce((total, [, count]) => total + count, 0);

  return [
    '## Appendix D — Not yet migrated',
    '',
    'Copy still written inline, counted by heuristic; this is the burndown.',
    'Templates: text between tags and `placeholder`, `aria-label`, `title`, `alt` and `label` values, ignoring icon ligatures.',
    'Client files: literals that carry an accent or start with a capitalised word, ignoring logging, error constructors, comparisons and DOM plumbing.',
    '',
    countTable('Templates (`src/web/views`)', templates, sum(templates)),
    '',
    countTable('Client files (`src/web/client`)', client, sum(client)),
  ].join('\n');
};

/**
 * The WhatsApp registry, with each variable's label from `admin-whatsapp`.
 *
 * @throws {Error} If a variable has no message under its ID.
 */
const whatsappAppendix = async (): Promise<string> => {
  const copy = await readCatalog(
    `${MESSAGES_DIR}/${BASE_LOCALE}/admin-whatsapp.json`,
  );

  const text = (id: string): string => {
    const message = copy[id];

    if (!message) throw new Error(`admin-whatsapp has no message ${id}`);

    return escapeMarkdown(message.defaultMessage);
  };

  const rows = Object.entries(WHATSAPP_TEMPLATES)
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([key, template]) => {
      const variables = [
        ...template.body,
        ...('urlButton' in template ? [template.urlButton.variable] : []),
      ].map((variable) => text(`admin-whatsapp.variable.${variable}`));

      return `| ${code(key)} | ${template.roles.join(', ')} | ${variables.join(', ')} |`;
    });

  return [
    '## Appendix E — External: WhatsApp templates',
    '',
    'The message bodies are approved by Meta and edited in WhatsApp Manager, not here.',
    'The registry is `src/constants/whatsapp-templates.ts`, and the admin picker lists each template by its key.',
    'The variables a template may send are governed by the published privacy notice.',
    '',
    '| Template | Audiences | Sends |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
};

/** Builds the whole document. */
async function renderInventory(): Promise<string> {
  const messages: Message[] = [];
  const translations = new Map<string, Set<string>>();
  const sections: string[] = [];
  const contents: string[] = [];
  const pending: string[] = [];

  for (const { name: ns, translatable } of NAMESPACES) {
    const sourcePath = `${MESSAGES_DIR}/${BASE_LOCALE}/${ns}.json`;

    if (!existsSync(sourcePath)) {
      pending.push(ns);
      continue;
    }

    for (const locale of LOCALES) {
      const path = `${MESSAGES_DIR}/${locale}/${ns}.json`;
      if (locale !== BASE_LOCALE && existsSync(path)) {
        translations.set(
          `${locale}/${ns}`,
          new Set(Object.keys(await readCatalog(path))),
        );
      }
    }

    const source = await readCatalog(sourcePath);
    const nsMessages = Object.entries(source)
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([id, entry]): Message => {
        const ast = parse(entry.defaultMessage);
        const { plurals, branches } = branchesOf(ast);

        return {
          ns,
          id,
          source: entry,
          args: collectArguments(ast, id),
          plurals: [...plurals].sort(byCodeUnit),
          branches,
          format: new IntlMessageFormat(ast, BASE_LOCALE),
        };
      });

    messages.push(...nsMessages);
    contents.push(
      `- [${ns}](#${anchor(ns)}) — ${String(nsMessages.length)} messages${translatable ? '' : ', not translated'}`,
    );
    sections.push(
      [
        `## ${ns}`,
        ...nsMessages.map((message) =>
          renderMessage(message, translatable, translations),
        ),
      ].join('\n\n'),
    );
  }

  const appendices = [
    duplicatesAppendix(messages),
    pluralSelectAppendix(messages),
    longestAppendix(messages),
    notMigratedAppendix(),
    await whatsappAppendix(),
  ];

  const appendixLinks = appendices.map((appendix) => {
    const title = appendix.slice(3, appendix.indexOf('\n'));
    return `- [${title}](#${anchor(title)})`;
  });

  return `${[
    '# Copy inventory',
    [
      'Generated by `npm run i18n:inventory` from `src/i18n/messages`. Do not edit by hand.',
      'Each message shows its pt-BR text, why it is worded that way, and its Ref.',
      'To propose a change, quote the Ref and the new wording, for example: `raffle.idle` → _Toque em gerar para começar_.',
    ].join('\n'),
    '## Contents',
    [
      ...contents,
      ...(pending.length > 0
        ? [`- No catalog yet: ${pending.join(', ')}`]
        : []),
      ...appendixLinks,
    ].join('\n'),
    ...sections,
    ...appendices,
  ].join('\n\n')}\n`;
}

const document = await renderInventory();

if (process.argv.includes('--check')) {
  const committed = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';

  if (committed !== document) {
    console.error(
      'i18n: docs/development/copy-inventory.md is stale; run `npm run i18n:inventory` (see docs/development/copy-management.md)',
    );
    process.exit(1);
  }

  console.log('✓ copy inventory is fresh');
} else {
  await writeFile(OUTPUT, document);
  console.log('wrote docs/development/copy-inventory.md');
}
