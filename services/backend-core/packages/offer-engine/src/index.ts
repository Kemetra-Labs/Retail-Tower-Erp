/**
 * `@data-pulse-2/offer-engine` (RT-1378): the one Offer Engine money evaluator (spec 048 §6, §9)
 * that the POS till and Backend-Core both import. Pure: no I/O, no clock, no database, no UI.
 */
export {
  MAX_EVALUATED_UNITS,
  evaluateOffer,
  totalDiscountOf,
  type CartLine,
  type EvaluateInput,
  type Evaluation,
  type EvaluatorOffer,
  type OfferUnit,
} from './offer-evaluator';
export {
  OfferDecimalError,
  formatColumnAmount,
  formatMinor,
  grossMinor,
  percentOf,
  scaled,
  wholeUnits,
} from './offer-decimal';
export {
  settleOfferReturn,
  type ReturnSettlement,
  type ReturnSettlementInput,
  type SaleOfferLine,
} from './offer-return-settlement';
