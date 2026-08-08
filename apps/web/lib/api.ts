/**
 * The API client.
 *
 * Three things it does that a bare `fetch` wrapper would not, each because of a
 * decision made elsewhere in this repository:
 *
 *   - It carries the correlation ID outward. The middleware honours an inbound
 *     `x-correlation-id`, so a trace that starts on a button click stays one trace
 *     through the API and the worker (Phase 0 exit criterion 5).
 *   - It turns the contract's error envelope into a typed error. Every failure has
 *     `code`, `message` and `correlation_id`, and the UI shows the correlation ID
 *     because that is the only thing a user can usefully quote to support.
 *   - It refreshes once on a 401 and retries. Access tokens are deliberately short
 *     (ADR-0005 §2), so without this every screen would bounce the user to sign-in
 *     roughly every fifteen minutes.
 */

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId: string,
    readonly fieldErrors: FieldError[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The message for one field, so a form can put it next to the input. */
  forField(field: string): string | undefined {
    return this.fieldErrors.find((e) => e.field === field)?.message;
  }
}

const ACCESS_TOKEN = 'acct.access_token';
const REFRESH_TOKEN = 'acct.refresh_token';
const TENANT_ID = 'acct.tenant_id';

export const session = {
  accessToken: () => read(ACCESS_TOKEN),
  refreshToken: () => read(REFRESH_TOKEN),
  tenantId: () => read(TENANT_ID),
  store(tokens: { access_token?: string; refresh_token?: string; tenant_id?: string | null }) {
    if (tokens.access_token) write(ACCESS_TOKEN, tokens.access_token);
    if (tokens.refresh_token) write(REFRESH_TOKEN, tokens.refresh_token);
    if (tokens.tenant_id) write(TENANT_ID, tokens.tenant_id);
  },
  clear() {
    [ACCESS_TOKEN, REFRESH_TOKEN, TENANT_ID].forEach((key) => {
      if (typeof window !== 'undefined') window.localStorage.removeItem(key);
    });
  },
};

function read(key: string): string | null {
  return typeof window === 'undefined' ? null : window.localStorage.getItem(key);
}
function write(key: string, value: string): void {
  if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Required by the contract on 86 operations; the API rejects the call without it. */
  idempotencyKey?: string;
  ifMatch?: string;
  anonymous?: boolean;
}

export async function api<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);

  if (response.status === 401 && !options.anonymous && session.refreshToken()) {
    const refreshed = await tryRefresh();
    if (refreshed) return unwrap<T>(await send(path, options));
  }
  return unwrap<T>(response);
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const url = new URL(path.replace(/^\//, ''), `${API_BASE_URL}/`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = session.accessToken();
  if (token && !options.anonymous) headers.authorization = `Bearer ${token}`;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.ifMatch) headers['if-match'] = options.ifMatch;
  headers['x-correlation-id'] = correlationId();

  return fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });
}

async function unwrap<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      String(body.code ?? 'INTERNAL'),
      String(body.message ?? response.statusText),
      String(body.correlation_id ?? response.headers.get('x-correlation-id') ?? ''),
      (body.field_errors as FieldError[]) ?? [],
    );
  }
  return body as T;
}

let refreshing: Promise<boolean> | null = null;

/** One refresh at a time. Six widgets rendering at once must not rotate six times. */
function tryRefresh(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refreshToken() }),
      });
      if (!response.ok) return false;
      session.store(await response.json());
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

/** Matches the API's SAFE_CORRELATION pattern, so the header is honoured rather than replaced. */
export function correlationId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `web-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A key for an operation the contract marks `x-idempotency: required`. */
export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${correlationId()}`;
}
