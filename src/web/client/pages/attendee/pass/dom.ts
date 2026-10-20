import { qs } from '../../../layouts/main/dom.ts';

const dom = Object.freeze({
  main: {
    container: qs('[data-pass="main-container"]'),
  },

  pass: qs('[data-pass="pass"]'),

  /** Takes the band's place when it stops refreshing. */
  retry: qs<HTMLButtonElement>('[data-pass="passRetry"]'),

  /** The line under the name: the welcome, or a volunteer's team and role. */
  tagline: qs('[data-pass="tagline"]'),

  face: {
    front: qs('[data-pass="faceFront"]'),
    back: qs('[data-pass="faceBack"]'),

    /** A volunteer's staff links, behind the access tab. */
    actions: qs('[data-pass="faceActions"]'),
    show: qs<HTMLButtonElement>('[data-pass="showQr"]'),
    hide: qs<HTMLButtonElement>('[data-pass="hideQr"]'),

    /** The tab at the head's right, in the tier colour; opens the actions. */
    accessTab: qs<HTMLButtonElement>('[data-pass="accessTab"]'),

    /** Laid over the wordmark on the actions face; returns to the front. */
    frontTab: qs<HTMLButtonElement>('[data-pass="frontTab"]'),
    hideActions: qs<HTMLButtonElement>('[data-pass="hideActions"]'),

    /** The chip list, listened to as a whole: its children are replaced on every poll. */
    chips: qs('[data-pass="chips"]'),
  },

  map: {
    /** A participant's way in, in the staff links row. */
    chip: qs<HTMLButtonElement>('[data-pass="mapChip"]'),

    /** A volunteer's way in, beside the verify button in the foot. */
    icon: qs<HTMLButtonElement>('[data-pass="mapIcon"]'),

    hide: qs<HTMLButtonElement>('[data-pass="hideMap"]'),
    dialog: qs<HTMLDialogElement>('[data-pass="mapDialog"]'),

    /** The frame the map is zoomed inside. */
    body: qs('[data-pass="mapBody"]'),
    image: qs<HTMLImageElement>('[data-pass="mapImage"]'),
  },

  nickname: {
    line: qs('[data-pass="nicknameLine"]'),
    trigger: qs<HTMLButtonElement>('[data-pass="nicknameTrigger"]'),
    form: qs<HTMLFormElement>('[data-pass="nicknameForm"]'),
    input: qs<HTMLInputElement>('[data-pass="nicknameInput"]'),
    save: qs<HTMLButtonElement>('[data-pass="nicknameSave"]'),
    cancel: qs<HTMLButtonElement>('[data-pass="nicknameCancel"]'),
    hint: qs('[data-pass="nicknameHint"]'),
  },
});

export default dom;
