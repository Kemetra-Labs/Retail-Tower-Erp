/**
 * RT-992 pipeline rail (DESIGN.md §12.2, D-V5): POS → server → ERPNext as three
 * nodes (status dot + name + one fact) joined by a dotted line, in a
 * `role="group"` named «مسار البيع».
 *
 * The fact is the caller's text and carries the node's state in words, so the
 * rail reads without colour: the dot (coloured by `status`) and the connector
 * are decoration (`aria-hidden`). The caller owns the facts; this component
 * owns no data and invents no state.
 */
import { useT } from "@/i18n";
import type { MessageKey } from "@/i18n";
import type { ReactNode } from "react";
import "./pipeline-rail.css";

export type PipelineRailNodeId = "pos" | "server" | "erp";

/** `ok` success, `attention` caution, `failed` a fault, `unknown` no signal. */
export type PipelineRailStatus = "ok" | "attention" | "failed" | "unknown";

export interface PipelineRailNode {
  id: PipelineRailNodeId;
  status: PipelineRailStatus;
  /** One fact, in words (for example «6/7 متصلة» or «3 متوقفة»). */
  fact: ReactNode;
}

const NAME_KEYS: Record<PipelineRailNodeId, MessageKey> = {
  pos: "pipelineRail.node.pos",
  server: "pipelineRail.node.server",
  erp: "pipelineRail.node.erp",
};

export function PipelineRail({
  nodes,
}: Readonly<{ nodes: readonly PipelineRailNode[] }>): React.JSX.Element {
  const t = useT();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group of read-only nodes, not form controls; a fieldset would announce a form grouping (DESIGN.md §12.2 asks for role="group").
    <div className="pipeline-rail" role="group" aria-label={t("pipelineRail.label")}>
      <ol className="pipeline-rail__nodes">
        {nodes.map((node, i) => (
          <li key={node.id} className="pipeline-rail__node">
            <span className="pipeline-rail__dot" data-status={node.status} aria-hidden="true" />
            <span className="pipeline-rail__text">
              <span className="pipeline-rail__name">{t(NAME_KEYS[node.id])}</span>{" "}
              <span className="pipeline-rail__fact">{node.fact}</span>
            </span>
            {i < nodes.length - 1 ? (
              <span className="pipeline-rail__link" aria-hidden="true" />
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
