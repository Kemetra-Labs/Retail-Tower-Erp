"""Retail Tower project graph: fail-closed evaluator, `required` aggregator and
layer-1 boundary check (RT-709 §A/§B, hardened by A.8 R1/R2/R5).

Every module here treats the head side of a pull request as data only. Nothing
reads, imports or executes code from the PR head."""

EVALUATOR_VERSION = "1.0.0"
PLAN_SCHEMA = "retail-tower/plan@1"
