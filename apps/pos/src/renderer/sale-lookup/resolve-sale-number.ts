import type { RecentSaleRow, SalesListRecentResponse } from '../../shared/bridge-api';
import {
  normalizeSaleLookupInput,
  resolveShortNumber,
} from '../../shared/sales/sale-number-display';
import type { RecentSalesBridge } from './recent-sales-bridge';

/**
 * RT-1192 (doc 20 §4) — what the number field means.
 *
 * - `empty`: nothing typed.
 * - `exact`: anything but one to nine digits is a full number. It goes to the
 *   screen's existing lookup (digits normalised) and the list is never read.
 * - `one` / `many` / `none`: a short form, resolved against today's sales on this
 *   terminal. With `many` the caller shows the candidates and never picks one.
 * - `failed`: the list could not be read (no bridge, refused, rejected). Never a
 *   guess: the caller says the lookup did not run.
 */
export type SaleNumberResolution =
  | { readonly kind: 'empty' }
  | { readonly kind: 'exact'; readonly saleNumber: string }
  | { readonly kind: 'one'; readonly saleNumber: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'many'; readonly candidates: readonly RecentSaleRow[] }
  | { readonly kind: 'failed' };

export async function resolveSaleNumber(
  bridge: RecentSalesBridge | null,
  raw: string,
): Promise<SaleNumberResolution> {
  const input = normalizeSaleLookupInput(raw);
  if (input.kind === 'empty') return { kind: 'empty' };
  if (input.kind === 'exact') return { kind: 'exact', saleNumber: input.value };
  if (bridge === null) return { kind: 'failed' };
  let answer: SalesListRecentResponse;
  try {
    answer = await bridge.listRecent({ short_number: input.digits });
  } catch {
    return { kind: 'failed' };
  }
  if (answer.kind !== 'ok') return { kind: 'failed' };
  const resolved = resolveShortNumber(answer.items, input.digits);
  if (resolved.kind === 'none') return { kind: 'none' };
  if (resolved.kind === 'one') return { kind: 'one', saleNumber: resolved.sale_number };
  const wanted = new Set(resolved.sale_numbers);
  return { kind: 'many', candidates: answer.items.filter((row) => wanted.has(row.sale_number)) };
}
