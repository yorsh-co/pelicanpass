import { classifyCsv, parseUploads } from '../core/detect.ts';
import { DEFAULT_FILTERS } from '../core/filter.ts';
import { generateSampleCsv } from '../core/sample.ts';
import { el } from './dom.ts';
import { store, update } from './state.ts';

import type { FileKind, UploadedFile } from '../core/detect.ts';
import type { Loaded } from './state.ts';

interface Pending extends UploadedFile {
  kind: FileKind;
}

let pending: Pending[] = [];
let error = '';
let busy = false;

const keyOf = (kind: FileKind): string =>
  kind.kind === 'checkin' ? 'checkin' : kind.audience;

/** Shows a loaded dataset and leaves the loader. */
const show = (data: Loaded): void => {
  store.data = data;
  error = '';
  update({
    loading: false,
    filters: { ...DEFAULT_FILTERS },
    item: null,
  });
};

/** Reads dropped files, classifying each; a replaced kind keeps the newest. */
const add = async (files: readonly File[]): Promise<void> => {
  const messages: string[] = [];

  busy = true;
  for (const file of files) {
    try {
      if (!file.name.toLowerCase().endsWith('.csv'))
        throw new Error('não é um arquivo .csv.');
      const text = await file.text();
      const kind = classifyCsv(text, store.definitions);

      pending = [
        ...pending.filter((p) => keyOf(p.kind) !== keyOf(kind)),
        { name: file.name, text, kind },
      ];
    } catch (cause) {
      messages.push(
        `${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  busy = false;
  error = messages.join('\n');
  update({});
};

const generate = (): void => {
  try {
    const parsed = parseUploads(pending, store.definitions);

    show({
      ...parsed,
      resumoHtml: null,
      generatedAt: new Date().toISOString(),
      sample: false,
      sources: pending.map((p) => p.name),
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    update({});
  }
};

const useSample = (): void => {
  const sample = generateSampleCsv(store.definitions);
  const files: UploadedFile[] = [
    { name: 'checkin-exemplo.csv', text: sample.checkin },
    { name: 'pesquisa-participantes-exemplo.csv', text: sample.participant },
    ...(sample.volunteer === null
      ? []
      : [{ name: 'pesquisa-voluntarios-exemplo.csv', text: sample.volunteer }]),
  ];

  show({
    ...parseUploads(files, store.definitions),
    resumoHtml: null,
    generatedAt: new Date().toISOString(),
    sample: true,
    sources: null,
  });
};

const SLOTS: readonly { key: string; label: string; required: boolean }[] = [
  { key: 'checkin', label: 'Check-in (resultados)', required: true },
  { key: 'participant', label: 'Pesquisa de participantes', required: false },
  { key: 'volunteer', label: 'Pesquisa de voluntários', required: false },
];

/** The "Carregar dados do evento" card. */
export const loader = (): HTMLElement => {
  const input = el('input', {
    attrs: {
      type: 'file',
      accept: '.csv,text/csv',
      multiple: '',
      'aria-label': 'Selecionar arquivos CSV',
    },
    on: {
      change: () => {
        void add([...(input.files ?? [])]);
        input.value = '';
      },
    },
  });
  const zone = el(
    'label',
    {
      class: 'dropzone',
      on: {
        dragover: (event) => {
          event.preventDefault();
          zone.classList.add('over');
        },
        dragleave: () => {
          zone.classList.remove('over');
        },
        drop: (event) => {
          event.preventDefault();
          zone.classList.remove('over');
          void add([...(event.dataTransfer?.files ?? [])]);
        },
      },
    },
    input,
    el('strong', {}, 'Solte os arquivos CSV aqui'),
    el(
      'span',
      {},
      'ou clique para selecionar (1 a 3 arquivos, em qualquer ordem)',
    ),
  );
  const has = (key: string): Pending | undefined =>
    pending.find((p) => keyOf(p.kind) === key);
  const generateButton = el(
    'button',
    {
      class: 'button primary',
      attrs: { type: 'button' },
      on: { click: generate },
    },
    'Gerar relatório',
  );

  generateButton.disabled = has('checkin') === undefined || busy;

  return el(
    'section',
    { class: 'loader card' },
    el('h1', { class: 'loader-title' }, 'Carregar dados do evento'),
    zone,
    el(
      'ul',
      { class: 'slots' },
      ...SLOTS.map((slot) => {
        const file = has(slot.key);

        return el(
          'li',
          { class: file ? 'ok' : '' },
          el(
            'span',
            {},
            slot.label,
            el('small', {}, slot.required ? ' · obrigatório' : ' · opcional'),
          ),
          el(
            'span',
            { class: 'slot-status' },
            file ? file.name : 'Não carregado',
          ),
        );
      }),
    ),
    error === ''
      ? null
      : el('p', { class: 'error', attrs: { role: 'alert' } }, error),
    el(
      'div',
      { class: 'actions' },
      generateButton,
      el(
        'button',
        {
          class: 'button',
          attrs: { type: 'button' },
          on: { click: useSample },
        },
        'Ver com dados de exemplo',
      ),
      store.data
        ? el(
            'button',
            {
              class: 'button',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  update({ loading: false });
                },
              },
            },
            'Voltar ao relatório',
          )
        : null,
    ),
    el(
      'p',
      { class: 'note' },
      'Os arquivos são lidos no seu navegador e não são enviados para nenhum servidor. Códigos de ingresso são descartados na leitura.',
    ),
  );
};
