export interface PortRule {
  property: string;
  operator: string;
  value?: unknown;
}

export interface PortQuery {
  combinator: "and" | "or";
  rules: PortRule[];
}

export interface SearchOptions {
  limit?: number;
  include?: string[];
}

export interface PortClient {
  search<T>(blueprint: string, query: PortQuery, opts?: SearchOptions): Promise<T[]>;
  get<T>(path: string): Promise<T>;
}

interface SearchPage<T> {
  entities?: T[];
  next?: string | null;
}

const DEFAULT_LIMIT = 1000;
// Hard stop for a host that keeps returning cursors (1000 per page).
const MAX_PAGES = 200;

/**
 * Read-only Port REST client. Never logs, stores or echoes the token: errors
 * carry the HTTP status only, not the response body.
 */
export function createPortClient(
  baseUrl: string,
  getToken: () => string | null,
  onUnauthorized: () => void,
): PortClient {
  const root = baseUrl.replace(/\/+$/, "");

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = getToken();
    if (!token) throw new Error("No Port token");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const init: RequestInit & { headers: Record<string, string> } = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${root}${path}`, init);
    if (res.status === 401) {
      onUnauthorized();
      throw new Error("Unauthorized");
    }
    if (!res.ok) throw new Error(`Port API ${res.status}`);
    return (await res.json()) as T;
  }

  async function search<T>(
    blueprint: string,
    query: PortQuery,
    opts: SearchOptions = {},
  ): Promise<T[]> {
    const path = `/v1/blueprints/${encodeURIComponent(blueprint)}/entities/search`;
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const out: T[] = [];
    const seen = new Set<string>();
    let from: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await request<SearchPage<T>>("POST", path, {
        query,
        limit,
        include: opts.include,
        from,
      });
      if (res.entities) out.push(...res.entities);
      const next = res.next;
      if (!next) return out;
      if (seen.has(next) || next === from) throw new Error("Port API paging did not advance");
      seen.add(next);
      from = next;
    }
    throw new Error("Port API paging did not advance");
  }

  async function get<T>(path: string): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Invalid Port API path");
    return request<T>("GET", path);
  }

  return { search, get };
}
