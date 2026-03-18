import { describe, expect, it, vi } from "vitest";

describe("auth backend", () => {
  it("returns anonymous auth context for the none backend", async () => {
    const { createAuthBackend } = await import("../../src/auth/index.js");
    const backend = createAuthBackend({ kind: "none" });

    await expect(
      backend.authenticateRequest({ headers: new Headers() }),
    ).resolves.toEqual({
      backend: "none",
      userId: "anonymous",
    });
  });

  it("rejects missing bearer tokens for the auth0 backend", async () => {
    vi.resetModules();
    vi.doMock("jose", () => ({
      createRemoteJWKSet: vi.fn(() => Symbol("jwks")),
      jwtVerify: vi.fn(),
    }));

    const { AuthError, createAuthBackend } = await import("../../src/auth/index.js");
    const backend = createAuthBackend({
      kind: "auth0",
      issuerBaseUrl: "https://example.auth0.com/",
      audience: "https://api.example.com",
    });

    await expect(
      backend.authenticateRequest({ headers: new Headers() }),
    ).rejects.toBeInstanceOf(AuthError);

    vi.doUnmock("jose");
  });

  it("extracts the subject from a verified auth0 token", async () => {
    const jwtVerify = vi.fn(async () => ({
      payload: {
        sub: "auth0|user-123",
        scope: "openid profile",
      },
    }));

    vi.resetModules();
    vi.doMock("jose", () => ({
      createRemoteJWKSet: vi.fn(() => Symbol("jwks")),
      jwtVerify,
    }));

    const { createAuthBackend } = await import("../../src/auth/index.js");
    const backend = createAuthBackend({
      kind: "auth0",
      issuerBaseUrl: "https://example.auth0.com/",
      audience: "https://api.example.com",
    });

    await expect(
      backend.authenticateRequest({
        headers: new Headers({
          authorization: "Bearer test-token",
        }),
      }),
    ).resolves.toEqual({
      backend: "auth0",
      userId: "auth0|user-123",
      subject: "auth0|user-123",
      claims: {
        sub: "auth0|user-123",
        scope: "openid profile",
      },
      token: "test-token",
    });

    expect(jwtVerify).toHaveBeenCalledTimes(1);
    expect(jwtVerify).toHaveBeenCalledWith(
      "test-token",
      expect.any(Symbol),
      expect.objectContaining({
        issuer: "https://example.auth0.com/",
        audience: "https://api.example.com",
      }),
    );
    vi.doUnmock("jose");
  });
});
