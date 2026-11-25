import { lazyPage } from "@/shell/lazyPage";
import { Route } from "react-router";

const SearchPage = lazyPage(() => import("@/search/SearchPage"), "SearchPage");

export const searchRoutes = <Route path="search" element={<SearchPage />} />;
