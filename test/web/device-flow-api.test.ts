import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWebServer, type WebServer } from "../../src/web/server.js";
import {
  decideDeviceAuthorization,
  deviceAuthorizationPath,
  normalizeUserCode,
} from "../../src/web/device-authorizations.js";
import { securityAuditSubjectFingerprint } from "../../src/web/security-audit.js";
import { createApiToken, listApiTokens } from "../../src/web/api-tokens.js";
import { createUser, findUserByIdOrEmail } from "../../src/web/users.js";
import { listSecurityAuditEvents } from "../../src/web/security-audit.js";
import { createTokenOwner } from "../helpers/token-owner.js";

const servers: WebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function createRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "nitely-device-flow-"));
}

async function startTestServer(
  repoPath: string,
  options: Partial<Parameters<typeof startWebServer>[0]> = {},
) {
  const server = await startWebServer({
    repoPath,
    host: "127.0.0.1",
    port: 0,
    providerCommandStatus: async () => false,
    authMode: "required",
    authEnv: {
      NITELY_ADMIN_EMAIL: "admin@example.test",
      NITELY_ADMIN_PASSWORD: "admin password passphrase",
    },
    ...options,
    repositories: [
      { id: "home", name: "home", path: repoPath },
      ...(options.repositories ?? []),
    ],
  });
  servers.push(server);
  return server;
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function authorize(server: WebServer, body: unknown = {
  capabilities: ["tasks:read"],
  clientName: "cli@dev-box",
}) {
  const response = await fetch(`${server.url}/api/device-authorization`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await json(response) };
}

async function exchange(server: WebServer, deviceCode: string) {
  const response = await fetch(`${server.url}/api/device-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  return { response, body: await json(response) };
}

describe("device flow protocol endpoints", () => {
  async function login(server: WebServer, email: string, password: string) {
    const response = await fetch(`${server.url}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  }

  async function decide(
    server: WebServer,
    cookie: string,
    userCode: string,
    decision: "approve" | "deny",
  ) {
    const response = await fetch(`${server.url}/api/device-authorizations/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ userCode, decision }),
    });
    return { response, body: await json(response) };
  }

  async function lookup(server: WebServer, cookie: string, userCode: string) {
    const response = await fetch(
      `${server.url}/api/device-authorizations/${encodeURIComponent(userCode)}`,
      { headers: cookie ? { cookie } : {} },
    );
    return { response, body: await json(response) };
  }

  it("issues codes with a verification URI that prefills the user code", async () => {
    const server = await startTestServer(await createRepo());

    const { response, body } = await authorize(server);

    expect(response.status).toBe(200);
    expect(String(body.user_code)).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    expect(body.verification_uri).toBe(`${server.url}/device`);
    expect(body.verification_uri_complete).toBe(
      `${server.url}/device?code=${body.user_code}`,
    );
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
    expect(String(body.device_code)).toContain(".");
  });

  it("rejects an authorize request with no capabilities", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const { response } = await authorize(server, { capabilities: [] });

    expect(response.status).toBe(400);

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.authorize",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "deny",
          outcome: "error",
          httpStatus: 400,
          reasonCode: "invalid_input",
          actor: expect.objectContaining({ type: "anonymous" }),
        }),
      ]),
    );
  });

  it("refuses a high-impact capability that was not explicitly allowed", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    const { response, body } = await authorize(server, {
      capabilities: ["tasks:read", "tasks:write"],
      clientName: "cli@dev-box",
    });

    // Refused here, not at exchange. `createApiToken` would refuse it too, but
    // only after an admin approved a consent screen that showed no warning —
    // and its bare Error would 500 every retry until the code expired.
    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: expect.objectContaining({ code: "invalid_input" }),
    });

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.authorize",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "deny",
          outcome: "error",
          httpStatus: 400,
          reasonCode: "invalid_input",
        }),
      ]),
    );
  });

  it("issues codes for a high-impact capability the client did allow", async () => {
    const server = await startTestServer(await createRepo());

    const { response } = await authorize(server, {
      capabilities: ["tasks:write"],
      clientName: "cli@dev-box",
      allowHighImpact: true,
    });

    expect(response.status).toBe(200);
  });

  it("reports authorization_pending until a decision is recorded", async () => {
    const server = await startTestServer(await createRepo());
    const { body } = await authorize(server);

    const pending = await exchange(server, String(body.device_code));

    expect(pending.response.status).toBe(400);
    expect(pending.body).toEqual({ error: "authorization_pending" });
  });

  it("mints a working token once approved, exactly once", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server, {
      capabilities: ["tasks:read"],
      clientName: "cli@dev-box",
    });
    const userCode = normalizeUserCode(String(body.user_code));
    // The minted token's owner must resolve to a real user, or the exchange is
    // correctly refused with owner_missing; approve as the bootstrapped admin.
    const admin = await findUserByIdOrEmail(repoPath, "admin@example.test");
    await decideDeviceAuthorization(repoPath, userCode as string, {
      decision: "approve",
      userId: admin!.id,
    });

    const exchanged = await exchange(server, String(body.device_code));
    expect(exchanged.response.status).toBe(200);
    expect(exchanged.body.name).toBe("cli@dev-box");
    expect(exchanged.body.capabilities).toEqual(["tasks:read"]);

    const listed = await fetch(`${server.url}/api/tasks`, {
      headers: { authorization: `Bearer ${String(exchanged.body.access_token)}` },
    });
    expect(listed.status).toBe(200);

    const replay = await exchange(server, String(body.device_code));
    expect(replay.body).toEqual({ error: "expired_token" });

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.exchange",
    });
    const success = events.find((event) => event.decision === "allow");
    expect(success).toEqual(
      expect.objectContaining({
        decision: "allow",
        httpStatus: 200,
        reasonCode: "ok",
        actor: expect.objectContaining({
          type: "api-token",
          id: exchanged.body.token_id,
        }),
      }),
    );
    const expired = events.find(
      (event) => event.decision === "deny" && event.reasonCode === "expired_token",
    );
    expect(expired).toEqual(
      expect.objectContaining({
        decision: "deny",
        outcome: "error",
        httpStatus: 400,
        reasonCode: "expired_token",
        actor: expect.objectContaining({ type: "anonymous" }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain(String(body.device_code));
    expect(JSON.stringify(events)).not.toContain(String(exchanged.body.access_token));
  });

  it("reports access_denied when the request was refused", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    await decideDeviceAuthorization(repoPath, normalizeUserCode(String(body.user_code)) as string, {
      decision: "deny",
      userId: "user_1",
    });

    const denied = await exchange(server, String(body.device_code));

    expect(denied.body).toEqual({ error: "access_denied" });

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.exchange",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "deny",
          outcome: "error",
          httpStatus: 400,
          reasonCode: "access_denied",
          actor: expect.objectContaining({ type: "anonymous" }),
        }),
      ]),
    );
  });

  it("reports expired_token for an unknown or malformed device code", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);

    expect((await exchange(server, "BDFHJKMN.nope")).body).toEqual({
      error: "expired_token",
    });
    expect((await exchange(server, "garbage")).body).toEqual({
      error: "expired_token",
    });

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.exchange",
    });
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toEqual(
        expect.objectContaining({
          decision: "deny",
          outcome: "error",
          httpStatus: 400,
          reasonCode: "expired_token",
          actor: expect.objectContaining({ type: "anonymous" }),
        }),
      );
    }
  });

  it("asks a fast poller to slow down without auditing the pending polls", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);

    await exchange(server, String(body.device_code));
    const second = await exchange(server, String(body.device_code));

    expect(second.body).toEqual({ error: "slow_down" });

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.exchange",
    });
    expect(events).toEqual([]);
  });

  it("refuses the flow in local auth mode, where nobody can approve", async () => {
    const server = await startTestServer(await createRepo(), {
      authMode: "local",
      authEnv: {},
    });

    const { response, body } = await authorize(server);

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "device_flow_unavailable" });
  });

  it("keeps API tokens out of both endpoints", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const created = await createApiToken(repoPath, {
      name: "reader",
      capabilities: ["tasks:read"],
      ownerUserId: (await createTokenOwner(repoPath)).id,
    });

    for (const path of ["/api/device-authorization", "/api/device-token"]) {
      const response = await fetch(`${server.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${created.token}`,
        },
        body: JSON.stringify({ capabilities: ["tasks:read"], device_code: "x.y" }),
      });
      expect(response.status).toBe(403);
    }
  });

  it("lets an admin approve, which unblocks the exchange", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    const decided = await decide(server, cookie, String(body.user_code), "approve");
    expect(decided.response.status).toBe(200);
    expect(decided.body).toMatchObject({ status: "approved" });

    const exchanged = await exchange(server, String(body.device_code));
    expect(exchanged.response.status).toBe(200);
    expect(typeof exchanged.body.access_token).toBe("string");

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.approve",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "allow",
          outcome: "success",
          httpStatus: 200,
          reasonCode: "ok",
          actor: expect.objectContaining({ type: "user" }),
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(String(body.user_code));
    expect(JSON.stringify(events)).not.toContain(String(body.device_code));
  });

  it("refuses approval from a non-admin session", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    await createUser(repoPath, {
      email: "member@example.test",
      password: "member password passphrase",
      role: "user",
    });
    const { body } = await authorize(server);
    const cookie = await login(server, "member@example.test", "member password passphrase");

    const decided = await decide(server, cookie, String(body.user_code), "approve");

    expect(decided.response.status).toBe(403);
    expect((await exchange(server, String(body.device_code))).body).toEqual({
      error: "authorization_pending",
    });

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.approve",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          decision: "deny",
          outcome: "error",
          httpStatus: 403,
          reasonCode: "forbidden",
          actor: expect.objectContaining({ type: "user" }),
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain(String(body.user_code));
    expect(JSON.stringify(events)).not.toContain(String(body.device_code));
  });

  it("refuses approval with no session at all", async () => {
    const server = await startTestServer(await createRepo());
    const { body } = await authorize(server);

    const decided = await decide(server, "", String(body.user_code), "approve");

    expect(decided.response.status).toBe(401);
  });

  it("throttles user-code guessing from an authenticated seat", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, {
      loginRateLimit: { maxFailures: 3, windowMs: 60_000 },
    });
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const guess = await decide(server, cookie, "BDFH-JKMN", "approve");
      statuses.push(guess.response.status);
    }

    expect(statuses).toContain(429);

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.approve",
    });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event).toEqual(
        expect.objectContaining({
          decision: "deny",
          outcome: "error",
          httpStatus: expect.any(Number),
          reasonCode: expect.stringMatching(/^(not_found|throttled)$/),
          actor: expect.objectContaining({ type: "user" }),
        }),
      );
    }
    // Tripping the guessing limiter is the event here most worth having: a
    // 429 that left no trace would hide the only evidence of the attempt.
    expect(
      events.some(
        (event) => event.httpStatus === 429 && event.reasonCode === "throttled",
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain("BDFH-JKMN");
  });

  it("denies a request end to end, and the exchange then reports access_denied", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    const denied = await decide(server, cookie, String(body.user_code), "deny");

    expect(denied.response.status).toBe(200);
    expect(denied.body.status).toBe("denied");

    const exchanged = await exchange(server, String(body.device_code));
    expect(exchanged.response.status).toBe(400);
    expect(exchanged.body).toEqual({ error: "access_denied" });

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.deny",
    });
    expect(events).toEqual([
      expect.objectContaining({
        decision: "allow",
        outcome: "success",
        httpStatus: 200,
        reasonCode: "ok",
        actor: expect.objectContaining({ type: "user", globalRole: "admin" }),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(String(body.user_code));
    expect(JSON.stringify(events)).not.toContain(String(body.device_code));
  });

  it("links the approving admin to the token their approval minted", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    await decide(server, cookie, String(body.user_code), "approve");
    const exchanged = await exchange(server, String(body.device_code));
    expect(exchanged.response.status).toBe(200);

    const approvals = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.approve",
      decision: "allow",
    });
    const exchanges = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.exchange",
      decision: "allow",
    });
    expect(approvals).toHaveLength(1);
    expect(exchanges).toHaveLength(1);

    const [minted] = await listApiTokens(repoPath);
    expect(minted.id).toBe(exchanged.body.token_id);
    expect(minted.ownerUserId).toBe(approvals[0]?.actor.id);

    // "Which admin caused this unowned, admin-capable token to exist" has to
    // be answerable from the log alone: the record holding approvedByUserId is
    // deleted at exchange, so nothing else is durable.
    const fingerprint = securityAuditSubjectFingerprint(
      normalizeUserCode(String(body.user_code)) as string,
    );
    expect(approvals[0]?.actor.subjectHash).toBe(fingerprint);
    expect(exchanges[0]?.actor.subjectHash).toBe(fingerprint);
    expect(exchanges[0]?.actor.id).toBe(exchanged.body.token_id);
    expect(exchanges[0]?.target).toEqual({
      type: "user",
      id: approvals[0]?.actor.id,
    });

    // The link is a fingerprint precisely so no live user code reaches the log.
    const raw = JSON.stringify([...approvals, ...exchanges]);
    expect(raw).not.toContain(String(body.user_code));
    expect(raw).not.toContain(normalizeUserCode(String(body.user_code)) as string);
    expect(raw).not.toContain(String(exchanged.body.access_token));
  });

  it("refuses to exchange an approved request that records no approver", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");
    await decide(server, cookie, String(body.user_code), "approve");

    // Simulate a record written by a version that did not link the approver.
    const recordPath = deviceAuthorizationPath(
      repoPath,
      normalizeUserCode(String(body.user_code)) as string,
    );
    const record = JSON.parse(await readFile(recordPath, "utf8")) as Record<string, unknown>;
    delete record.approvedByUserId;
    await writeFile(recordPath, JSON.stringify(record));

    const exchanged = await exchange(server, String(body.device_code));
    expect(exchanged.response.status).toBe(400);
    expect(exchanged.body).toEqual({ error: "access_denied" });
    expect(await listApiTokens(repoPath)).toEqual([]);
  });

  it("rejects a second decision on the same request", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    await decide(server, cookie, String(body.user_code), "approve");
    const second = await decide(server, cookie, String(body.user_code), "deny");

    expect(second.response.status).toBe(400);
  });

  it("rejects a malformed decision value instead of defaulting to approve", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    const response = await fetch(`${server.url}/api/device-authorizations/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ userCode: String(body.user_code), decision: "yes please" }),
    });

    expect(response.status).toBe(400);

    // The vulnerability this pins: a malformed decision must never silently
    // approve. Confirm the request is still pending, not approved.
    const exchanged = await exchange(server, String(body.device_code));
    expect(exchanged.body).toEqual({ error: "authorization_pending" });
  });

  it("throttles unknown device codes without throttling a legitimate poller", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    const { body } = await authorize(server);

    // Every rejected poll costs a stat and an audit write, and an audit write
    // is two fsyncs: without a limiter an unauthenticated caller can force a
    // synchronous disk flush per request.
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const guess = await exchange(server, `BDFHJKMN.secret-${attempt}`);
      statuses.push(guess.response.status);
    }
    expect(statuses).toContain(429);

    // The 429 body keeps RFC 8628's flat shape, and writes no audit event of
    // its own — auditing it would restore the amplification being throttled.
    const throttled = await exchange(server, "BDFHJKMN.secret-again");
    expect(throttled.response.status).toBe(429);
    expect(throttled.body).toEqual({ error: "slow_down" });
    expect(throttled.response.headers.get("retry-after")).toBeTruthy();

    const events = await listSecurityAuditEvents(repoPath, {
      action: "auth.device.exchange",
    });
    expect(events.length).toBeLessThan(statuses.length);
    for (const event of events) {
      expect(event.reasonCode).toBe("expired_token");
    }
  });

  it("holds the device endpoints closed in local auth mode", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath, { authMode: "local" });

    // Under --auth local, resolveUserContext hands back a synthetic admin to a
    // caller with no session at all, so every device endpoint must refuse —
    // not only the two the CLI reaches first.
    const approve = await fetch(`${server.url}/api/device-authorizations/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userCode: "BDFH-JKMN", decision: "approve" }),
    });
    expect(approve.status).toBe(409);
    expect((await json(approve)).error).toEqual(
      expect.objectContaining({ code: "device_flow_unavailable" }),
    );

    const look = await fetch(`${server.url}/api/device-authorizations/BDFH-JKMN`);
    expect(look.status).toBe(409);
    expect((await json(look)).error).toEqual(
      expect.objectContaining({ code: "device_flow_unavailable" }),
    );
  });

  it("shows an admin the client name and capabilities of a pending request", async () => {
    const server = await startTestServer(await createRepo());
    const { body } = await authorize(server, {
      capabilities: ["tasks:read", "runs:start"],
      clientName: "cli@dev-box",
      allowHighImpact: true,
    });
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    const { response, body: details } = await lookup(server, cookie, String(body.user_code));

    expect(response.status).toBe(200);
    expect(details).toEqual({
      clientName: "cli@dev-box",
      capabilities: ["tasks:read", "runs:start"],
      // The page marks these individually rather than warning off
      // allowHighImpact, which only says the client would permit one.
      highImpactCapabilities: ["runs:start"],
      allowHighImpact: true,
      expiresAt: expect.any(String),
    });
  });

  it("reports no high-impact capabilities for a read-only request that allows them", async () => {
    const server = await startTestServer(await createRepo());
    const { body } = await authorize(server, {
      capabilities: ["tasks:read"],
      clientName: "cli@dev-box",
      allowHighImpact: true,
    });
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    const { body: details } = await lookup(server, cookie, String(body.user_code));

    // The consent screen keys its warning off this, so a request that asks
    // for nothing high-impact must not produce one.
    expect(details.highImpactCapabilities).toEqual([]);
  });

  it("refuses the lookup with no session and for a non-admin session", async () => {
    const repoPath = await createRepo();
    const server = await startTestServer(repoPath);
    await createUser(repoPath, {
      email: "member@example.test",
      password: "member password passphrase",
      role: "user",
    });
    const { body } = await authorize(server);

    const anonymous = await lookup(server, "", String(body.user_code));
    expect(anonymous.response.status).toBe(401);

    const memberCookie = await login(server, "member@example.test", "member password passphrase");
    const asMember = await lookup(server, memberCookie, String(body.user_code));
    expect(asMember.response.status).toBe(403);
  });

  it("returns an identical 404 for an unknown code and an already-decided code", async () => {
    const server = await startTestServer(await createRepo());
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    const unknown = await lookup(server, cookie, "BDFH-JKMN");
    expect(unknown.response.status).toBe(404);

    await decide(server, cookie, String(body.user_code), "approve");
    const decided = await lookup(server, cookie, String(body.user_code));
    expect(decided.response.status).toBe(404);

    // The two responses must be indistinguishable: same status, same body.
    expect(decided.body).toEqual(unknown.body);
  });

  it("never returns the device code or its hash from the lookup", async () => {
    const server = await startTestServer(await createRepo());
    const { body } = await authorize(server);
    const cookie = await login(server, "admin@example.test", "admin password passphrase");

    const { response, body: details } = await lookup(server, cookie, String(body.user_code));

    expect(response.status).toBe(200);
    expect(details).not.toHaveProperty("deviceCode");
    expect(details).not.toHaveProperty("deviceCodeHash");
    expect(details).not.toHaveProperty("userCode");
    expect(JSON.stringify(details)).not.toContain(String(body.device_code));
  });
});
