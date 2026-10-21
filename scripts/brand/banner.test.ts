import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BANNER_VIEWBOX, bannerSvg } from './banner.ts';
import { PALETTE } from './palette.ts';
import { PRIMARY_VIEWBOX, primaryWordmark } from './wordmark.ts';

/** The nested wordmark's placement attributes, as numbers. */
const placement = (svg: string) => {
  const match =
    /<svg x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(
      svg,
    );
  assert.ok(match, 'nested wordmark has x, y, width and height');
  const [x, y, width, height] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  return { x, y, width, height };
};

describe('banner', () => {
  const svg = bannerSvg();

  it('has the exact viewBox', () => {
    assert.ok(
      svg.includes(
        `viewBox="0 0 ${String(BANNER_VIEWBOX.width)} ${String(BANNER_VIEWBOX.height)}"`,
      ),
    );
  });

  it('sits the lockup on a Harbour rounded rectangle', () => {
    assert.match(
      svg,
      new RegExp(
        `<rect width="1280" height="320" rx="[\\d.]+" fill="${PALETTE.harbour}"/>`,
      ),
    );
  });

  it('embeds the primary wordmark unchanged', () => {
    const inner = primaryWordmark().replace(/^<svg [^>]*>/, '');
    assert.ok(svg.includes(inner));
    assert.ok(
      svg.includes(
        `viewBox="0 0 ${String(PRIMARY_VIEWBOX.width)} ${String(PRIMARY_VIEWBOX.height)}"`,
      ),
    );
  });

  it('is outlined, with no live text or external references', () => {
    assert.doesNotMatch(svg, /<text|<tspan|font-family|<image|href=/);
  });

  it('keeps the wordmark inside the banner and centred', () => {
    const { x, y, width, height } = placement(svg);
    assert.ok(x > 0 && y > 0);
    assert.ok(x + width < BANNER_VIEWBOX.width);
    assert.ok(y + height < BANNER_VIEWBOX.height);
    assert.ok(Math.abs(x - (BANNER_VIEWBOX.width - x - width)) < 0.01);
    assert.ok(Math.abs(y - (BANNER_VIEWBOX.height - y - height)) < 0.01);
    assert.ok(
      Math.abs(
        width / height - PRIMARY_VIEWBOX.width / PRIMARY_VIEWBOX.height,
      ) < 0.01,
    );
  });
});
