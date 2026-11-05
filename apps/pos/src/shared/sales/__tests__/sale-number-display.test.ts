/**
 * RT-1189 (RT-249 N-S1, doc 20 §2, §4, §9) — the short form of a sale number
 * and the normalisation of what a cashier types into the lookup field.
 */

import { describe, expect, it } from 'vitest';

import {
  normalizeSaleLookupInput,
  resolveShortNumber,
  saleNumberDisplay,
  shortNumberSuffix,
} from '../sale-number-display.js';

const row = (sale_number: string, local_calendar_day: string) => ({
  sale_number,
  local_calendar_day,
});

describe('saleNumberDisplay', () => {
  it.each([
    ['RT-159 audit-2026-10-06-000001', '2026-10-06', '1'],
    ['A-B-C-2026-10-06-000047', '2026-10-06', '47'],
    ['TERM-01-2026-10-06-1000000', '2026-10-06', '1000000'],
    ['TERM-01-2026-10-06-000100', '2026-10-06', '100'],
    ['Dev Terminal-2026-10-06-000009', '2026-10-06', '9'],
  ])('%s gives %s', (sale_number, day, short) => {
    expect(saleNumberDisplay(row(sale_number, day))).toEqual({ exact: sale_number, short });
  });

  it('gives null when the embedded date is not the stored day', () => {
    expect(saleNumberDisplay(row('TERM-01-2026-10-06-000001', '2026-10-07')).short).toBeNull();
  });

  it.each([
    'garbage',
    '',
    'TERM-01-2026-10-06-00001', // five digits: not a sequence part
    'TERM-01-2026-10-06-00000x',
    '2026-10-06-000001', // no label
    'TERM-01-2026-10-06-000001\n',
  ])('gives null for malformed %j and never throws', (sale_number) => {
    expect(saleNumberDisplay(row(sale_number, '2026-10-06')).short).toBeNull();
  });

  it('gives null for a sequence beyond the safe-integer range', () => {
    const huge = `TERM-01-2026-10-06-${'9'.repeat(20)}`;
    expect(saleNumberDisplay(row(huge, '2026-10-06')).short).toBeNull();
  });

  it('never throws on non-string input', () => {
    const bad = { sale_number: 42, local_calendar_day: null } as unknown as ReturnType<typeof row>;
    expect(saleNumberDisplay(bad).short).toBeNull();
  });
});

describe('normalizeSaleLookupInput', () => {
  it('reads Western digits as a short form', () => {
    expect(normalizeSaleLookupInput('47')).toEqual({ kind: 'short', digits: '47' });
  });

  it.each([
    ['٤٧', '47'], // Arabic-Indic U+0660..0669
    ['۴۷', '47'], // Extended Arabic-Indic U+06F0..06F9
    ['٠٤٧', '47'], // leading zeros are not part of the short form
    ['  ٤٧  ', '47'],
    ['4٧', '47'], // mixed
    ['‎٤٧‏', '47'], // bidi marks from a copy
    ['⁦٤٧⁩', '47'],
  ])('normalises %j to the short form %s', (raw, digits) => {
    expect(normalizeSaleLookupInput(raw)).toEqual({ kind: 'short', digits });
  });

  it('accepts one to nine digits and no more', () => {
    expect(normalizeSaleLookupInput('123456789')).toEqual({ kind: 'short', digits: '123456789' });
    expect(normalizeSaleLookupInput('1234567890').kind).toBe('exact');
  });

  it('reads anything else as the exact number, normalised', () => {
    expect(normalizeSaleLookupInput(' RT-159 audit-2026-10-06-٠٠٠٠٤٧ ')).toEqual({
      kind: 'exact',
      value: 'RT-159 audit-2026-10-06-000047',
    });
    expect(normalizeSaleLookupInput('4a').kind).toBe('exact');
  });

  it.each(['', '   ', '‎', '؜  '])('reads %j as empty', (raw) => {
    expect(normalizeSaleLookupInput(raw)).toEqual({ kind: 'empty' });
  });

  it('reads a non-string as empty rather than throwing', () => {
    expect(normalizeSaleLookupInput(undefined as unknown as string)).toEqual({ kind: 'empty' });
  });
});

describe('shortNumberSuffix', () => {
  it('pads to the allocator width of six digits', () => {
    expect(shortNumberSuffix('47')).toBe('-000047');
    expect(shortNumberSuffix('1')).toBe('-000001');
    expect(shortNumberSuffix('1000000')).toBe('-1000000');
  });
});

describe('resolveShortNumber', () => {
  const item = (sale_number: string, short_number: string | null) => ({
    sale_number,
    short_number,
  });

  it('returns none when nothing matches', () => {
    expect(resolveShortNumber([item('A-2026-10-06-000001', '1')], '2')).toEqual({ kind: 'none' });
    expect(resolveShortNumber([], '2')).toEqual({ kind: 'none' });
  });

  it('returns the one exact number when one row matches', () => {
    expect(
      resolveShortNumber([item('A-2026-10-06-000001', '1'), item('A-2026-10-06-000002', '2')], '2'),
    ).toEqual({ kind: 'one', sale_number: 'A-2026-10-06-000002' });
  });

  it('returns every exact number when several match, in the given order', () => {
    expect(
      resolveShortNumber(
        [
          item('A-2026-10-07-000002', '2'),
          item('A-2026-10-06-000002', '2'),
          item('A-2026-10-06-000003', '3'),
        ],
        '2',
      ),
    ).toEqual({
      kind: 'many',
      sale_numbers: ['A-2026-10-07-000002', 'A-2026-10-06-000002'],
    });
  });

  it('never matches a row whose short form is null', () => {
    expect(resolveShortNumber([item('weird', null)], '1')).toEqual({ kind: 'none' });
  });
});
