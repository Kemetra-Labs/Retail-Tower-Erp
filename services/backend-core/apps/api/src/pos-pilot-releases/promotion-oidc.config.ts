/**
 * RT-1298: the pins of the pilot promotion credential. Owner decision D-5a
 * (RT-1290, comment 16280): the owner-run promotion workflow authenticates to
 * Backend-Core with its GitHub OIDC token, so there is no stored secret. The
 * token is accepted only when it matches ALL of these settings.
 *
 * | Variable                                  | Meaning |
 * |-------------------------------------------|---------|
 * | `POS_PILOT_PROMOTION_OIDC_AUDIENCE`       | The `aud` the workflow requests for its token. |
 * | `POS_PILOT_PROMOTION_OIDC_REPOSITORY`     | The `repository` claim, `owner/name`. |
 * | `POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID`  | The `repository_id` claim: the immutable numeric id of the repository (RT-1459). |
 * | `POS_PILOT_PROMOTION_OIDC_REPOSITORY_OWNER_ID` | The `repository_owner_id` claim: the immutable numeric id of the owning organisation (RT-1459). |
 * | `POS_PILOT_PROMOTION_OIDC_ENVIRONMENT`    | The `environment` claim: the protected approval environment of the promotion job. |
 * | `POS_PILOT_PROMOTION_OIDC_REF`            | The `ref` claim, such as `refs/heads/main`. |
 * | `POS_PILOT_PROMOTION_OIDC_WORKFLOW_REF`   | The `job_workflow_ref` claim: `owner/name/.github/workflows/<file>@<ref>`. |
 *
 * Pure: it reads an environment object and answers the pins or the closed reason
 * the writes are off. While any value is blank no token is accepted and nothing
 * is written (fail closed). A refusal never carries a value.
 *
 * RT-1459 (audit A-13): `repository` and `job_workflow_ref` are names. If a
 * repository or organisation is renamed or deleted and the name is reused, a
 * token from the new repository carries the same names, so the two numeric ids
 * GitHub stamps on every token (and never reuses) are pinned as well.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** Why the promotion writes are off; never a value. */
type PromotionOidcRefusal = "not_configured" | "incomplete" | "invalid";

export type PromotionOidcConfig =
  | {
      readonly enabled: true;
      readonly audience: string;
      readonly repository: string;
      /** The `repository_id` claim, a decimal string (GitHub sends it as a string). */
      readonly repositoryId: string;
      /** The `repository_owner_id` claim, a decimal string. */
      readonly repositoryOwnerId: string;
      readonly environment: string;
      readonly ref: string;
      readonly workflowRef: string;
    }
  | { readonly enabled: false; readonly reason: PromotionOidcRefusal };

const REPOSITORY_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A GitHub numeric id as the token's string claim: canonical decimal, positive, no leading zero (so it can equal the claim).
const NUMERIC_ID_SHAPE = /^[1-9][0-9]{0,19}$/;
const REF_SHAPE = /^refs\/(heads|tags)\/\S+$/;
// The workflow file at a branch, a tag, or (a workflow GitHub resolved by commit) a 40-hex commit SHA.
const WORKFLOW_REF_SHAPE =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[^@\s/]+@(refs\/(heads|tags)\/\S+|[0-9a-f]{40})$/;

/** True when the pins have the shape GitHub puts in a token. */
function hasTokenShape(pins: {
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  ref: string;
  workflowRef: string;
}): boolean {
  return (
    REPOSITORY_SHAPE.test(pins.repository) &&
    NUMERIC_ID_SHAPE.test(pins.repositoryId) &&
    NUMERIC_ID_SHAPE.test(pins.repositoryOwnerId) &&
    REF_SHAPE.test(pins.ref) &&
    WORKFLOW_REF_SHAPE.test(pins.workflowRef)
  );
}

/** Resolve the pins from an environment object; any refusal turns the writes off. */
export function resolvePromotionOidcConfig(env: Env): PromotionOidcConfig {
  // Literal keys: test/deploy/compose-api-env.spec.ts finds every setting the api reads by them.
  const audience = (env["POS_PILOT_PROMOTION_OIDC_AUDIENCE"] ?? "").trim();
  const repository = (env["POS_PILOT_PROMOTION_OIDC_REPOSITORY"] ?? "").trim();
  const repositoryId = (env["POS_PILOT_PROMOTION_OIDC_REPOSITORY_ID"] ?? "").trim();
  const repositoryOwnerId = (env["POS_PILOT_PROMOTION_OIDC_REPOSITORY_OWNER_ID"] ?? "").trim();
  const environment = (env["POS_PILOT_PROMOTION_OIDC_ENVIRONMENT"] ?? "").trim();
  const ref = (env["POS_PILOT_PROMOTION_OIDC_REF"] ?? "").trim();
  const workflowRef = (env["POS_PILOT_PROMOTION_OIDC_WORKFLOW_REF"] ?? "").trim();
  const values = [audience, repository, repositoryId, repositoryOwnerId, environment, ref, workflowRef];

  if (values.every((value) => value === "")) return { enabled: false, reason: "not_configured" };
  if (values.includes("")) return { enabled: false, reason: "incomplete" };
  if (!hasTokenShape({ repository, repositoryId, repositoryOwnerId, ref, workflowRef })) return { enabled: false, reason: "invalid" };
  return { enabled: true, audience, repository, repositoryId, repositoryOwnerId, environment, ref, workflowRef };
}
