import { lazyPage } from "@/shell/lazyPage";

const LazyPostingHealth = lazyPage(
  () => import("@/posting-health/PostingHealth").then((m) => ({ default: m.PostingHealth })),
  "postingHealth",
);

export const postingHealthRoutes = <LazyPostingHealth path="/posting-health" />;
