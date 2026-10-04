/**
 * coverSpecs.test — the Cover Studio's print math must be exact; KDP rejects
 * covers built to wrong dimensions. Reference case throughout: 6×9, 300 pages,
 * white paper.
 */

import { describe, it, expect } from 'vitest';
import {
  BLEED_IN,
  DPI,
  EBOOK_COVER,
  MIN_PAGE_COUNT,
  PAPER_TYPES,
  SPINE_TEXT_MIN_PAGES,
  TRIM_SIZES,
  buildArtPrompt,
  buildPrintSpecsText,
  buildTeachMePrompt,
  clampPageCount,
  coverSlug,
  formatIn,
  frontCoverPrintPixels,
  fullWrapSpec,
  getGenre,
  getPaperSpec,
  getTrimSize,
  inchesToPixels,
  spineTextAllowed,
  spineWidthIn,
} from './coverSpecs';
import type { CoverBrief } from './coverSpecs';

const BRIEF: CoverBrief = {
  title: 'The Long Road Home',
  subtitle: 'A Life Rebuilt',
  author: 'Topher Cook',
  genreId: 'memoir',
  notes: 'warm dawn light over an Arkansas field',
  trimId: '6x9',
  pageCount: 300,
  paper: 'white',
};

describe('constants', () => {
  it('uses KDP standard bleed and DPI', () => {
    expect(BLEED_IN).toBe(0.125);
    expect(DPI).toBe(300);
  });

  it('ebook cover is 1600x2560', () => {
    expect(EBOOK_COVER.widthPx).toBe(1600);
    expect(EBOOK_COVER.heightPx).toBe(2560);
  });

  it('includes the required KDP trim sizes', () => {
    const ids = TRIM_SIZES.map((t) => t.id);
    for (const id of ['5x8', '5.25x8', '5.5x8.5', '6x9']) {
      expect(ids).toContain(id);
    }
  });

  it('paper types carry KDP per-page thickness', () => {
    expect(getPaperSpec('white').inchesPerPage).toBe(0.002252);
    expect(getPaperSpec('cream').inchesPerPage).toBe(0.0025);
    expect(getPaperSpec('color').inchesPerPage).toBe(0.002347);
    expect(PAPER_TYPES).toHaveLength(3);
  });
});

describe('getTrimSize', () => {
  it('finds a trim by id', () => {
    const t = getTrimSize('5.5x8.5');
    expect(t.widthIn).toBe(5.5);
    expect(t.heightIn).toBe(8.5);
  });

  it('falls back to 6x9 for unknown ids', () => {
    const t = getTrimSize('nope');
    expect(t.widthIn).toBe(6);
    expect(t.heightIn).toBe(9);
  });
});

describe('inchesToPixels', () => {
  it('converts at 300 DPI and rounds', () => {
    expect(inchesToPixels(6)).toBe(1800);
    expect(inchesToPixels(9)).toBe(2700);
    expect(inchesToPixels(0.125)).toBe(38); // 37.5 rounds up
  });
});

describe('spineWidthIn', () => {
  it('300 pages white = 0.6756in', () => {
    expect(spineWidthIn(300, 'white')).toBeCloseTo(0.6756, 6);
  });

  it('300 pages cream = 0.75in', () => {
    expect(spineWidthIn(300, 'cream')).toBeCloseTo(0.75, 6);
  });

  it('300 pages color = 0.7041in', () => {
    expect(spineWidthIn(300, 'color')).toBeCloseTo(0.7041, 6);
  });

  it('floors fractional page counts and never goes negative', () => {
    expect(spineWidthIn(300.9, 'white')).toBeCloseTo(0.6756, 6);
    expect(spineWidthIn(-10, 'white')).toBe(0);
  });
});

describe('spineTextAllowed / clampPageCount', () => {
  it('requires 79+ pages for spine text', () => {
    expect(spineTextAllowed(SPINE_TEXT_MIN_PAGES - 1)).toBe(false);
    expect(spineTextAllowed(SPINE_TEXT_MIN_PAGES)).toBe(true);
  });

  it('clamps to KDP min/max per paper', () => {
    expect(clampPageCount(2, 'white')).toBe(MIN_PAGE_COUNT);
    expect(clampPageCount(5000, 'white')).toBe(828);
    expect(clampPageCount(5000, 'cream')).toBe(776);
    expect(clampPageCount(NaN, 'white')).toBe(MIN_PAGE_COUNT);
    expect(clampPageCount(300, 'white')).toBe(300);
  });
});

describe('fullWrapSpec — 6x9, 300 pages, white (reference case)', () => {
  const wrap = fullWrapSpec('6x9', 300, 'white');

  it('spine is 0.6756in', () => {
    expect(wrap.spineIn).toBeCloseTo(0.6756, 6);
  });

  it('width = bleed + back + spine + front + bleed = 12.9256in', () => {
    expect(wrap.widthIn).toBeCloseTo(12.9256, 6);
  });

  it('height = 9 + 2×0.125 = 9.25in', () => {
    expect(wrap.heightIn).toBeCloseTo(9.25, 6);
  });

  it('pixel dimensions at 300 DPI: 3878 × 2775', () => {
    expect(wrap.widthPx).toBe(3878); // 12.9256 × 300 = 3877.68
    expect(wrap.heightPx).toBe(2775);
    expect(wrap.spinePx).toBe(203); // 0.6756 × 300 = 202.68
    expect(wrap.bleedPx).toBe(38);
  });

  it('flags spine text as allowed at 300 pages', () => {
    expect(wrap.spineTextOk).toBe(true);
  });

  it('clamps out-of-range page counts', () => {
    expect(fullWrapSpec('6x9', 10, 'white').pageCount).toBe(MIN_PAGE_COUNT);
  });
});

describe('fullWrapSpec — other combos', () => {
  it('5x8, 100 pages, cream', () => {
    const w = fullWrapSpec('5x8', 100, 'cream');
    expect(w.spineIn).toBeCloseTo(0.25, 6);
    expect(w.widthIn).toBeCloseTo(0.125 + 5 + 0.25 + 5 + 0.125, 6); // 10.5
    expect(w.heightIn).toBeCloseTo(8.25, 6);
    expect(w.widthPx).toBe(3150);
    expect(w.heightPx).toBe(2475);
  });
});

describe('frontCoverPrintPixels', () => {
  it('6x9 → 1800 × 2700 px', () => {
    expect(frontCoverPrintPixels('6x9')).toEqual({ widthPx: 1800, heightPx: 2700 });
  });

  it('5.5x8.5 → 1650 × 2550 px', () => {
    expect(frontCoverPrintPixels('5.5x8.5')).toEqual({ widthPx: 1650, heightPx: 2550 });
  });
});

describe('formatIn / coverSlug', () => {
  it('formats inches to 3 decimals without trailing zeros', () => {
    expect(formatIn(12.9256)).toBe('12.926"');
    expect(formatIn(9.25)).toBe('9.25"');
    expect(formatIn(6)).toBe('6"');
  });

  it('slugs titles safely', () => {
    expect(coverSlug('The Long Road Home')).toBe('the-long-road-home');
    expect(coverSlug("God's Plan: A Story!")).toBe('gods-plan-a-story');
    expect(coverSlug('   ')).toBe('untitled');
  });
});

describe('getGenre', () => {
  it('finds genres and falls back to memoir', () => {
    expect(getGenre('faith').label).toContain('Faith');
    expect(getGenre('unknown').id).toBe('memoir');
  });
});

describe('buildArtPrompt', () => {
  const prompt = buildArtPrompt(BRIEF);

  it('forbids text in the artwork', () => {
    expect(prompt).toMatch(/NO text/i);
    expect(prompt).toMatch(/added separately/i);
  });

  it('carries genre art direction and author notes', () => {
    expect(prompt).toContain('memoir');
    expect(prompt).toContain('Arkansas field');
    expect(prompt).toContain(BRIEF.title);
  });
});

describe('buildTeachMePrompt', () => {
  const prompt = buildTeachMePrompt(BRIEF);

  it('bakes in the exact computed dimensions', () => {
    expect(prompt).toContain('0.676"'); // spine
    expect(prompt).toContain('12.926" × 9.25"'); // full wrap inches
    expect(prompt).toContain('3878 × 2775 px'); // full wrap pixels
    expect(prompt).toContain('1800 × 2700 px'); // front cover
    expect(prompt).toContain('1600 × 2560 px'); // ebook
  });

  it('asks for free tools and KDP upload steps', () => {
    expect(prompt).toContain('Canva');
    expect(prompt).toContain('GIMP');
    expect(prompt).toMatch(/KDP/);
  });

  it('mentions the missing-spine-text caveat for thin books', () => {
    const thin = buildTeachMePrompt({ ...BRIEF, pageCount: 60 });
    expect(thin).toContain('too thin for spine text');
  });
});

describe('buildPrintSpecsText', () => {
  const specs = buildPrintSpecsText(BRIEF);

  it('includes full-wrap dimensions and spine width', () => {
    expect(specs).toContain('12.926"');
    expect(specs).toContain('9.25"');
    expect(specs).toContain('0.676"');
    expect(specs).toContain('3878 × 2775 px');
  });

  it('includes Canva finishing steps and the barcode zone', () => {
    expect(specs).toContain('Canva');
    expect(specs).toMatch(/barcode zone/i);
    expect(specs).toContain('2" × 1.2"');
  });

  it('places the front panel at back + spine + bleed offset', () => {
    // 0.125 + 6 + 0.6756 = 6.8006 → formatted 6.801"
    expect(specs).toContain('6.801"');
  });
});
