import { createRemoteJWKSet, jwtVerify } from "jose";

export interface NoneAuthBackendOptions {
  kind: "none";
}

export interface Auth0AuthBackendOptions {
  kind: "auth0";
  issuerBaseUrl: string;
  audience: string;
  jwksUri?: string;
  clockToleranceSeconds?: number;
}

export type AuthBackendOptions =
  | NoneAuthBackendOptions
  | Auth0AuthBackendOptions;

export interface AuthContext {
  backend: "none" | "auth0";
  userId: string;
  subject?: string;
  claims?: Record<string, unknown>;
  token?: string;
}

export interface AuthBackend {
  readonly kind: AuthBackendOptions["kind"];
  authenticateRequest(input: {
    headers: Headers | Record<string, string | undefined>;
  }): Promise<AuthContext>;
}

export class AuthError extends Error {
  readonly status: number;
  readonly wwwAuthenticate: string;

  constructor(
    message: string,
    options: {
      status?: number;
      wwwAuthenticate?: string;
    } = {},
  ) {
    super(message);
    this.name = "AuthError";
    this.status = options.status ?? 401;
    this.wwwAuthenticate = options.wwwAuthenticate ?? 'Bearer realm="ai-kit"';
  }
}

export function createAuthBackend(options: AuthBackendOptions): AuthBackend {
  switch (options.kind) {
    case "none":
      return new NoneAuthBackend();
    case "auth0":
      return new Auth0AuthBackend(options);
    default:
      return assertNever(options);
  }
}

class NoneAuthBackend implements AuthBackend {
  readonly kind = "none" as const;

  async authenticateRequest(): Promise<AuthContext> {
    return {
      backend: "none",
      userId: "anonymous",
    };
  }
}

class Auth0AuthBackend implements AuthBackend {
  readonly kind = "auth0" as const;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly clockToleranceSeconds: number;

  constructor(options: Auth0AuthBackendOptions) {
    this.issuer = normalizeIssuerBaseUrl(options.issuerBaseUrl);
    this.audience = options.audience;
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? 60;
    const jwksUri = new URL(
      options.jwksUri ?? `${stripTrailingSlashes(this.issuer)}/.well-known/jwks.json`,
    );
    this.jwks = createRemoteJWKSet(jwksUri);
  }

  async authenticateRequest(input: {
    headers: Headers | Record<string, string | undefined>;
  }): Promise<AuthContext> {
    const token = extractBearerToken(input.headers);
    if (!token) {
      throw new AuthError(
        "Missing Authorization bearer token",
        {
          wwwAuthenticate: 'Bearer realm="ai-kit", error="invalid_token"',
        },
      );
    }

    try {
      const verified = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: this.clockToleranceSeconds,
      });
      const claims = verified.payload as Record<string, unknown>;
      const subject = typeof claims.sub === "string" ? claims.sub : "";
      if (!subject) {
        throw new AuthError(
          "Auth0 token is missing sub claim",
          {
            wwwAuthenticate: 'Bearer realm="ai-kit", error="invalid_token"',
          },
        );
      }
      return {
        backend: "auth0",
        userId: subject,
        subject,
        claims,
        token,
      };
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError(
        error instanceof Error ? error.message : "Invalid bearer token",
        {
          wwwAuthenticate: 'Bearer realm="ai-kit", error="invalid_token"',
        },
      );
    }
  }
}

function extractBearerToken(
  headers: Headers | Record<string, string | undefined>,
): string | null {
  const headerValue = headers instanceof Headers
    ? headers.get("authorization")
    : headers.authorization ?? headers.Authorization;
  if (!headerValue) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return match?.[1]?.trim() || null;
}

function normalizeIssuerBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Auth0 auth backend requires issuerBaseUrl");
  }
  return `${stripTrailingSlashes(trimmed)}/`;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function assertNever(value: never): never {
  throw new Error(`Unsupported auth backend: ${JSON.stringify(value)}`);
}
