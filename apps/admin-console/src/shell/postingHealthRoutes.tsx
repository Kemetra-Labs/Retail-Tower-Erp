import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const PostingHealth = lazyPage(() => import("@/posting-health/PostingHealth"), "PostingHealth");

export const postingHealthRoutes = <Route path="posting-health" element={<PostingHealth />} />;
