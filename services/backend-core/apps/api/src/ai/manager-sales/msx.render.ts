/**
 * RT-1539 — the Tier-0 executor of the Manager Sales feature: pure and synchronous,
 * `(evidencePack) => manager_sales.answer/1`. No clock, no I/O, no question text and no model: it runs
 * the template over the pack alone, so every number in the answer is a pack field copied as the read
 * returned it, with its ref (RT-1526 §2.4). The latency of the ledger metadata is measured by the
 * route, not here (this function has no clock), so it leaves the field at zero.
 */
import type { EvidencePack } from "../ports/model-provider.port";
import {
  MSX_OUTPUT_SCHEMA_ID,
  MSX_TASK_CLASS,
  MSX_TEMPLATES_VERSION,
  MSX_MATCH_VERSION,
} from "./msx.constants";
import { fieldPathOf, parseRef, SRC_OPERATION, SRC_ITEM_REF } from "./msx.figures";
import type { ManagerSalesAnswer } from "./msx.output";
import { ctxOfMeta, packSource, parseMeta } from "./msx.pack";
import { renderBlocks, type Block } from "./msx.templates";
import { stripBidi } from "./msx.text";

export { stripBidi };

/** A store name is untrusted display text: bidi controls are stripped, the value is otherwise as read. */
function cleaned(blocks: readonly Block[]): Block[] {
  return blocks.map((block) =>
    block.type === "statement"
      ? block
      : {
          ...block,
          rows: block.rows.map((row) =>
            row.map((cell) => (parseRef(cell.ref)?.metric === "storeName" && typeof cell.value === "string" ? { ...cell, value: stripBidi(cell.value) } : cell)),
          ),
        },
  );
}

function refsOf(blocks: readonly Block[]): string[] {
  const refs = new Set<string>();
  for (const block of blocks) {
    if (block.type === "table") for (const row of block.rows) for (const cell of row) refs.add(cell.ref);
    else for (const slot of Object.values(block.slots)) refs.add(slot.ref);
  }
  return [...refs];
}

export function renderAnswer(pack: EvidencePack): ManagerSalesAnswer {
  const meta = parseMeta(pack);
  const blocks = cleaned(renderBlocks(ctxOfMeta(meta), packSource(pack)));
  const items = new Map(pack.items.map((item) => [item.ref, item.fields] as const));

  const sources = meta.sources.map((src) => {
    const fields = items.get(SRC_ITEM_REF[src]);
    if (fields === undefined) throw new Error(`pack has no ${SRC_ITEM_REF[src]}`);
    return {
      operationId: SRC_OPERATION[src],
      contractVersion: String(fields["contractVersion"]),
      asOf: String(fields["asOf"]),
      completeness: "received_only" as const,
    };
  });

  const citations = refsOf(blocks).map((ref) => {
    const parsed = parseRef(ref);
    if (parsed === null) throw new Error("a cited ref is not in the msx ref grammar");
    return { ref, operationId: SRC_OPERATION[parsed.src], fieldPath: fieldPathOf(ref) };
  });

  return {
    kind: "answer",
    templateId: meta.templateId,
    templateVersion: MSX_TEMPLATES_VERSION,
    outputSchemaId: MSX_OUTPUT_SCHEMA_ID,
    scope: { mode: meta.mode, storeRefs: [...meta.storeRefs] },
    period: {
      from: meta.from,
      to: meta.to,
      ...(meta.baseline === null ? {} : { baseline: { ...meta.baseline } }),
    },
    sources,
    blocks: blocks as ManagerSalesAnswer["blocks"],
    citations,
    notices: ["received_only", ...meta.notices.filter((n) => n !== "received_only")],
    declined: [...meta.declined],
    gaps: [...meta.gaps],
    ledger: {
      routeKey: "deterministic_no_model",
      routing_tier: 0,
      task_class: MSX_TASK_CLASS,
      classifier_version: MSX_MATCH_VERSION,
      catalogue_version: MSX_TEMPLATES_VERSION,
      latency_ms: 0,
    },
  };
}
