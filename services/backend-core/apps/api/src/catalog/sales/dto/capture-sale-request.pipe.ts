/**
 * RT-77 — the captureSale body pipe. Picks the schema PER REQUEST from the
 * `POS_SALE_TENDERS_ENABLED` gate: off (the default) → the pre-RT-77 strict
 * `CaptureSaleRequestSchema`, so `tenders` is an unknown key and the 400 body
 * is byte-identical to today; on → `CaptureSaleRequestWithTendersSchema`.
 * RT-360: with `POS_SALE_TENDERS_SAME_METHOD_ENABLED` on as well →
 * `CaptureSaleRequestWithSameMethodTendersSchema` (same-method split tenders).
 * RT-1114: with `POS_SALE_VOUCHER_TENDER_ENABLED` on as well → the matching
 * schema that also accepts `voucher` tenders. Off (the default, until R-4b is
 * deployed) a `voucher` tender is the same 400 as any unknown method.
 * A ZodError is rendered by the GlobalExceptionFilter, as for ZodValidationPipe.
 */
import { Injectable, type ArgumentMetadata, type PipeTransform } from "@nestjs/common";

import {
  isPosSaleTendersEnabled,
  isPosSaleTendersSameMethodEnabled,
  isPosSaleVoucherTenderEnabled,
} from "../sale-tenders-gate";
import {
  CaptureSaleRequestSchema,
  CaptureSaleRequestWithSameMethodTendersSchema,
  CaptureSaleRequestWithSameMethodVoucherTendersSchema,
  CaptureSaleRequestWithTendersSchema,
  CaptureSaleRequestWithVoucherTendersSchema,
  type CaptureSaleRequestDto,
} from "./capture-sale-request.dto";

@Injectable()
export class CaptureSaleRequestPipe implements PipeTransform<unknown, CaptureSaleRequestDto> {
  transform(value: unknown, _metadata: ArgumentMetadata): CaptureSaleRequestDto {
    return captureSchema().parse(value);
  }
}

function captureSchema() {
  if (!isPosSaleTendersEnabled()) return CaptureSaleRequestSchema;
  const sameMethod = isPosSaleTendersSameMethodEnabled();
  if (isPosSaleVoucherTenderEnabled()) {
    return sameMethod ? CaptureSaleRequestWithSameMethodVoucherTendersSchema : CaptureSaleRequestWithVoucherTendersSchema;
  }
  return sameMethod ? CaptureSaleRequestWithSameMethodTendersSchema : CaptureSaleRequestWithTendersSchema;
}
