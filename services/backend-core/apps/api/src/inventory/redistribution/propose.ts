/**
 * RT-1598 (W9 N1) — the one entry point: run `reorder_gap_greedy`, then the independent validator, and return
 * a `RedistributionResultV1`. A plan the validator rejects, or whose objective the validator does not
 * reproduce, becomes `invalid` with no moves; a refused or late run returns no moves either. Never partial.
 */
import { type EngineOptions, type EnginePlan, planReorderGapGreedy } from './engine/reorder-gap-greedy';
import { RULE_V1 } from './policy';
import type {
  RedistributionProblemV1,
  RedistributionResultV1,
  RedistributionStatusV1,
  RedistributionViolationV1,
} from './types';
import { validateRedistributionPlan } from './validator/validate-plan';

export type ProposeOptions = EngineOptions;

export function proposeRedistribution(
  problem: RedistributionProblemV1,
  options: ProposeOptions = {},
): RedistributionResultV1 {
  const now = options.now ?? Date.now;
  return finalizePlan(problem, planReorderGapGreedy(problem, { now }), now);
}

function emptyResult(
  status: RedistributionStatusV1,
  validator: RedistributionResultV1['validator'],
): RedistributionResultV1 {
  return { status, rule: RULE_V1, moves: [], objective: null, validator, warnings: [] };
}

/** Joins an engine plan with the validator's verdict (exported so a broken plan can be tested directly). */
export function finalizePlan(
  problem: RedistributionProblemV1,
  plan: EnginePlan,
  now: () => number,
): RedistributionResultV1 {
  if (plan.kind === 'refused_too_large' || plan.kind === 'deadline_exceeded') return emptyResult(plan.kind, null);
  if (plan.kind === 'input_invalid') return emptyResult('invalid', { passed: false, violations: plan.violations });

  const report = validateRedistributionPlan(problem, plan.moves);
  const violations: RedistributionViolationV1[] = [...report.violations];
  const reproduced =
    report.deficitBefore === plan.objective.deficitBefore && report.deficitAfter === plan.objective.deficitAfter;
  if (violations.length === 0 && !reproduced) {
    violations.push({
      code: 'objective_mismatch',
      detail:
        `engine ${plan.objective.deficitBefore} -> ${plan.objective.deficitAfter}, ` +
        `validator ${report.deficitBefore} -> ${report.deficitAfter}`,
    });
  }
  if (violations.length > 0) return emptyResult('invalid', { passed: false, violations });
  if (now() > plan.startedAt + problem.limits.deadlineMs) return emptyResult('deadline_exceeded', null);
  return {
    status: plan.moves.length > 0 ? 'proposed' : 'nothing_to_move',
    rule: RULE_V1,
    moves: plan.moves,
    objective: plan.objective,
    validator: { passed: true, violations: [] },
    warnings: plan.warnings,
  };
}
