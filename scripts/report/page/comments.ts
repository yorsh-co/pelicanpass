import { textComments } from '../core/metrics.ts';
import { el } from './dom.ts';
import { fmtInt, fold } from './format.ts';
import { state, update } from './state.ts';
import { note, select } from './ui.ts';

import type { TextComment } from '../core/metrics.ts';
import type { Ctx } from './ctx.ts';

/** Text questions that are not feedback: they classify the respondent. */
const EXCLUDED = new Set(['volunteer_area']);

interface Comment extends TextComment {
  /** The question as listed, naming the parent when it is a follow-up. */
  option: string;
}

/** The respondent's answer to the parent question, or `null` if unknown. */
const answerLabel = (answer: number | boolean | null): string | null =>
  answer === null
    ? null
    : typeof answer === 'boolean'
      ? answer
        ? 'Sim'
        : 'Não'
      : `Nota ${fmtInt(answer)}`;

/** The "Comentários" tab. Answers are untrusted and only ever set as text. */
export const comments = (ctx: Ctx): HTMLElement => {
  const { data, filters } = ctx;
  const { comments: view } = state;
  const audience =
    view.audience === 'follow' ? filters.audience : view.audience;
  const all: Comment[] = (['participant', 'volunteer'] as const)
    .filter((a) => audience === 'all' || audience === a)
    .flatMap((a) => {
      const survey = data.surveys[a];

      return survey
        ? textComments(survey)
            .filter((t) => !EXCLUDED.has(t.questionId))
            .map((t) => ({
              ...t,
              option:
                t.parent === null ? t.label : `${t.parent.label} → ${t.label}`,
            }))
        : [];
    });
  const questions = [
    ...new Map(all.map((c) => [c.questionId, c.option])).entries(),
  ];
  const question = questions.some(([id]) => id === view.question)
    ? view.question
    : '';
  const needle = fold(view.query.trim());
  const shown = all.filter(
    (c) =>
      (question === '' || c.questionId === question) &&
      (needle === '' || fold(c.text).includes(needle)),
  );
  const LIMIT = 300;

  const search = el('input', {
    attrs: {
      type: 'search',
      placeholder: 'Buscar nos comentários',
      'aria-label': 'Buscar nos comentários',
      'data-focus': 'comment-search',
    },
    on: {
      input: () => {
        update({ comments: { ...view, query: search.value } });
      },
    },
  });

  search.value = view.query;

  return el(
    'div',
    { class: 'stack' },
    el(
      'div',
      { class: 'toolbar' },
      el('label', { class: 'field' }, el('span', {}, 'Busca'), search),
      select(
        'Público',
        [
          { value: 'all', label: 'Todos' },
          { value: 'participant', label: 'Participantes' },
          { value: 'volunteer', label: 'Voluntários' },
        ],
        audience,
        (value) => {
          update({
            comments: {
              ...view,
              audience: value as 'all' | 'participant' | 'volunteer',
              question: '',
            },
          });
        },
      ),
      select(
        'Pergunta',
        [
          { value: '', label: 'Todas' },
          ...questions.map(([id, label]) => ({ value: id, label })),
        ],
        question,
        (value) => {
          update({ comments: { ...view, question: value } });
        },
      ),
    ),
    el(
      'p',
      { class: 'note', attrs: { 'aria-live': 'polite' } },
      `${fmtInt(shown.length)} respostas`,
    ),
    el(
      'div',
      { class: 'comments' },
      ...shown.slice(0, LIMIT).map((c) => {
        const answer = c.parent && answerLabel(c.parent.answer);

        return el(
          'blockquote',
          { class: 'comment' },
          el('p', {}, c.text),
          el(
            'footer',
            {},
            answer ? el('strong', { class: 'comment-answer' }, answer) : null,
            answer ? ' · ' : null,
            c.option,
          ),
        );
      }),
    ),
    shown.length > LIMIT
      ? note(
          `Mostrando as primeiras ${fmtInt(LIMIT)}. Refine a busca para ver as demais.`,
        )
      : null,
  );
};
