/**
 * RT-1509 (D1): the seven-step strip of the import workspace. It borrows the pipeline rail's
 * grammar (numbered nodes, one fact per node, the state in words so it reads without colour) but is
 * its own component: `PipelineRail`'s node ids are fixed to `pos | server | erp`.
 *
 * The nodes are read-only text in an ordered list, not tab stops. The current node carries
 * `aria-current="step"`. The caller owns the facts; the step comes from the server's batch state,
 * never from the screen.
 */
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n";
import { type ImportStep, STEP_ORDER } from "./catalogImportLogic";
import "./catalog-import.css";

const NAME_KEYS: Record<ImportStep, MessageKey> = {
  upload: "catalogImport.step.upload",
  map: "catalogImport.step.map",
  validate: "catalogImport.step.validate",
  review: "catalogImport.step.review",
  preview: "catalogImport.step.preview",
  publish: "catalogImport.step.publish",
  result: "catalogImport.step.result",
};

/** The fact line of a node, by state; the current step may add its own fact. */
export interface StepperProps {
  current: ImportStep;
  /** Extra fact of the current step (for example the row count), already translated. */
  currentFact?: string;
  /** The current node reads «يلزم تحقق جديد» (a validation is needed again). */
  needsValidation?: boolean;
}

export function stepName(step: ImportStep): MessageKey {
  return NAME_KEYS[step];
}

export function stepNumber(step: ImportStep): number {
  return STEP_ORDER.indexOf(step) + 1;
}

type NodeState = "done" | "current" | "todo";

function factOf(
  t: ReturnType<typeof useT>,
  step: ImportStep,
  state: NodeState,
  { currentFact, needsValidation }: Pick<StepperProps, "currentFact" | "needsValidation">,
): string {
  if (state === "done") return t("catalogImport.stepFact.done");
  if (state === "todo") {
    const masculine = step === "publish" || step === "upload";
    return t(
      masculine ? "catalogImport.stepFact.notStartedM" : "catalogImport.stepFact.notStarted",
    );
  }
  const head = needsValidation
    ? t("catalogImport.stepFact.needsValidation")
    : t("catalogImport.stepFact.current");
  return [head, currentFact].filter(Boolean).join(" · ");
}

function StepNode({
  step,
  index,
  state,
  fact,
}: Readonly<{ step: ImportStep; index: number; state: NodeState; fact: string }>) {
  const t = useT();
  return (
    <li
      className="import-stepper__node"
      data-state={state}
      aria-current={state === "current" ? "step" : undefined}
    >
      <span className="import-stepper__name">
        <span className="import-stepper__num" aria-hidden="true">
          {index + 1}
        </span>
        {t(NAME_KEYS[step])}
      </span>
      <span className="import-stepper__fact">{fact}</span>
    </li>
  );
}

export function ImportStepper({
  current,
  currentFact,
  needsValidation = false,
}: Readonly<StepperProps>): React.JSX.Element {
  const t = useT();
  const at = STEP_ORDER.indexOf(current);
  return (
    // biome-ignore lint/a11y/useSemanticElements: Safari drops list semantics from a marker-free list; the role restores them.
    // biome-ignore lint/a11y/noRedundantRoles: the same reason: the explicit role is the Safari workaround.
    <ol className="import-stepper" role="list" aria-label={t("catalogImport.stepper.label")}>
      {STEP_ORDER.map((step, i) => {
        const state: NodeState = i < at ? "done" : i === at ? "current" : "todo";
        const fact = factOf(t, step, state, { currentFact, needsValidation });
        return <StepNode key={step} step={step} index={i} state={state} fact={fact} />;
      })}
    </ol>
  );
}
