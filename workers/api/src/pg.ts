// The PostgREST client, and the translation from a Postgres error into an API error.
//
// Everything this Worker does to the database goes through a token minted for one org, so
// the fencing is Row Level Security rather than a WHERE clause somebody has to remember
// to write. That is also why the error translation lives here: the database raises
// errcodes on purpose (P0002 for no such row, 54000 for a limit reached) and the mapping
// from those to a status is a contract, not an implementation detail.

import { ApiError, type ErrorCode } from "./http";

export interface PgError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export interface PostgrestOptions {
  schema?: string;
  headers?: Record<string, string>;
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  signal?: AbortSignal;
}

export class Postgrest {
  constructor(
    private readonly baseUrl: string,
    private readonly anonKey: string,
    private readonly token: string,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/rest/v1/${path.replace(/^\/+/, "")}`;
  }

  async request(path: string, opts: PostgrestOptions = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
    const method = opts.method ?? "GET";
    const headers: Record<string, string> = {
      // The anon key is the API gateway ticket, not an authorisation: Supabase requires it
      // on every call and the bearer token below is what actually decides the role.
      apikey: this.anonKey,
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
      ...(opts.headers ?? {}),
    };
    if (opts.schema) {
      // PostgREST picks the schema per request. Reads use Accept-Profile and writes,
      // including an RPC, use Content-Profile.
      headers["accept-profile"] = opts.schema;
      headers["content-profile"] = opts.schema;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    const response = await fetch(this.url(path), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });

    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // A non-JSON body from PostgREST means something in front of it answered instead,
        // which is the same class of problem as the HTML interstitial README.md warns
        // about. It is logged as itself rather than guessed at.
        console.error("postgrest returned a non-JSON body", response.status, text.slice(0, 512));
        throw new ApiError(503, "unavailable", "the database is not answering normally", undefined, {
          "retry-after": "5",
        });
      }
    }
    return { status: response.status, body, headers: response.headers };
  }

  /** A read. Returns the rows, or throws the API error the database already implied. */
  async select(path: string, opts: PostgrestOptions = {}): Promise<unknown[]> {
    const { status, body } = await this.request(path, opts);
    if (status >= 400) throw pgErrorToApiError(body as PgError, status);
    return Array.isArray(body) ? body : body === null ? [] : [body];
  }

  async rpc(name: string, args: Record<string, unknown>, opts: PostgrestOptions = {}): Promise<unknown> {
    const { status, body } = await this.request(`rpc/${name}`, { ...opts, method: "POST", body: args });
    if (status >= 400) throw pgErrorToApiError(body as PgError, status);
    return body;
  }
}

/**
 * Which limit a 54000 was about.
 *
 * submit_job raises program_limit_exceeded with prose, because prose is what a person
 * reads. The API contract also promises `detail.limit`, a stable name a client can branch
 * on, so the name is recovered here from the one place that knows both: the wording in
 * supabase/migrations/0010_submit.sql.
 */
export function limitFromMessage(message: string): string | undefined {
  const m = message.toLowerCase();
  if (m.includes("ops, the limit is")) return "max_script_ops";
  if (m.includes("monthly job limit")) return "max_jobs_per_month";
  if (m.includes("monthly render seconds limit")) return "max_render_seconds_per_month";
  if (m.includes("storage limit")) return "max_stored_bytes";
  if (m.includes("concurrent")) return "max_concurrent_renders";
  return undefined;
}

/**
 * Postgres errcode to HTTP.
 *
 * P0002 is answered as 404 rather than 403 everywhere, because the functions raise it for
 * both "no such job" and "not yours". Telling those apart at the edge would hand an
 * attacker an oracle for which job ids exist in another tenant, which is exactly what the
 * schema went out of its way to avoid.
 */
export function pgErrorToApiError(body: PgError | null, httpStatus: number): ApiError {
  const code = body?.code ?? "";
  const message = body?.message ?? "the database refused the request";

  switch (code) {
    case "P0002":
      return new ApiError(404, "not_found", "no such job, project or artifact for this caller");
    case "54000": {
      const limit = limitFromMessage(message);
      return new ApiError(402, "limit_exceeded", message, limit ? { limit } : undefined);
    }
    case "22023":
      return new ApiError(422, "script_invalid", message);
    case "23505":
      return new ApiError(409, "idempotency_conflict", "that idempotency key is already in use");
    case "42501":
      // Insufficient privilege for a machine caller means it asked for something an API
      // key is not for. Answered as not found for the same reason P0002 is.
      return new ApiError(404, "not_found", "no such job, project or artifact for this caller");
    case "PGRST301":
    case "PGRST302":
      return new ApiError(401, "unauthorized", "the credential was not accepted by the database");
    default:
      break;
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return new ApiError(401, "unauthorized", "the credential was not accepted by the database");
  }
  if (httpStatus === 404) {
    return new ApiError(404, "not_found", "no such job, project or artifact for this caller");
  }
  if (httpStatus === 503 || httpStatus === 504) {
    return new ApiError(503, "unavailable", "the database is not accepting work", undefined, { "retry-after": "5" });
  }

  console.error("unmapped postgres error", httpStatus, code, message);
  const fallback: ErrorCode = "internal";
  return new ApiError(500, fallback, "an unexpected error occurred on our side");
}
