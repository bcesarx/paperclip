// INT-465 Gate A/B — promotion-time gates in startNextQueuedRunForAgent.
// Gate A: queued run whose card is done/cancelled -> cancelled with
// error_code='card_closed' BEFORE claimQueuedRun (never running, no slot).
// Gate B (promotion): queued run whose card belongs to a closed project
// (paused_at/archived_at) -> cancelled with error_code='project_closed'.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  companySkills,
  companies,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Gate test run completed.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres closed-card gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat closed-card / closed-project promotion gate", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-closed-card-gate-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    runningProcesses.clear();
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Gate test run completed.",
      provider: "test",
      model: "test-model",
    }));
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const activeProjectId = randomUUID();
    const closedProjectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Gate Co",
      status: "active",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Gate Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(projects).values([
      { id: activeProjectId, companyId, name: "Active Project", status: "in_progress" },
      {
        id: closedProjectId,
        companyId,
        name: "Closed Project",
        status: "completed",
        pausedAt: new Date("2026-10-17T12:11:33.940Z"),
      },
    ]);

    return { companyId, agentId, activeProjectId, closedProjectId };
  }

  async function seedIssue(
    companyId: string,
    agentId: string,
    fields: { status: string; projectId: string | null; createdAt: Date },
  ) {
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: `Gate issue ${randomUUID().slice(0, 8)}`,
        status: fields.status,
        priority: "medium",
        assigneeAgentId: agentId,
        projectId: fields.projectId,
        createdAt: fields.createdAt,
        updatedAt: fields.createdAt,
      })
      .returning();
    return issue;
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    createdAt: Date;
    contextExtras?: Record<string, unknown>;
    wakeReason?: string;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const wakeReason = input.wakeReason ?? "issue_assigned";
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      status: "queued",
      reason: wakeReason,
      payload: { issueId: input.issueId },
      requestedAt: input.createdAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId: input.issueId, wakeReason, ...(input.contextExtras ?? {}) },
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    });
    return { runId, wakeupRequestId };
  }

  async function readRun(runId: string) {
    return db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function readWakeup(wakeupRequestId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
  }

  it("test 1+2: queued runs on cancelled/done cards are cancelled with card_closed and never run", async () => {
    const { companyId, agentId, activeProjectId } = await seedFixture();
    const base = Date.now();

    const cancelledCard = await seedIssue(companyId, agentId, {
      status: "cancelled",
      projectId: activeProjectId,
      createdAt: new Date(base),
    });
    const doneCard = await seedIssue(companyId, agentId, {
      status: "done",
      projectId: activeProjectId,
      createdAt: new Date(base + 1000),
    });
    const cancelledRun = await seedQueuedRun({
      companyId,
      agentId,
      issueId: cancelledCard.id,
      createdAt: new Date(base),
    });
    const doneRun = await seedQueuedRun({
      companyId,
      agentId,
      issueId: doneCard.id,
      createdAt: new Date(base + 1000),
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await readRun(cancelledRun.runId)).toMatchObject({
      status: "cancelled",
      errorCode: "card_closed",
      startedAt: null,
    });
    expect(await readRun(doneRun.runId)).toMatchObject({
      status: "cancelled",
      errorCode: "card_closed",
      startedAt: null,
    });

    const cancelledWakeup = await readWakeup(cancelledRun.wakeupRequestId);
    expect(cancelledWakeup).toMatchObject({ status: "cancelled", reason: "card_closed" });
    const doneWakeup = await readWakeup(doneRun.wakeupRequestId);
    expect(doneWakeup).toMatchObject({ status: "cancelled", reason: "card_closed" });

    const runningCount = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"))
      .then((rows) => rows.length);
    expect(runningCount).toBe(0);
  });

  // CR-INT-466-01 (INT-471): the comment-wake / resumeIntent exemption is gone.
  // A queued run carrying commentId/wakeCommentId or resumeIntent on a closed
  // card must die with card_closed exactly like a plain assignment wake.
  it("CR-1: queued run with commentId/wakeCommentId on a done card is cancelled card_closed and never runs", async () => {
    const { companyId, agentId, activeProjectId } = await seedFixture();
    const base = Date.now();

    const doneCard = await seedIssue(companyId, agentId, {
      status: "done",
      projectId: activeProjectId,
      createdAt: new Date(base),
    });
    const commentId = randomUUID();
    const commentWake = await seedQueuedRun({
      companyId,
      agentId,
      issueId: doneCard.id,
      createdAt: new Date(base),
      wakeReason: "issue_comment",
      contextExtras: { commentId, wakeCommentId: commentId, wakeCommentIds: [commentId] },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await readRun(commentWake.runId)).toMatchObject({
      status: "cancelled",
      errorCode: "card_closed",
      startedAt: null,
    });
    const wake = await readWakeup(commentWake.wakeupRequestId);
    expect(wake).toMatchObject({ status: "cancelled", reason: "card_closed" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("CR-2: queued run with resumeIntent on a cancelled card is cancelled card_closed and never runs", async () => {
    const { companyId, agentId, activeProjectId } = await seedFixture();
    const base = Date.now();

    const cancelledCard = await seedIssue(companyId, agentId, {
      status: "cancelled",
      projectId: activeProjectId,
      createdAt: new Date(base),
    });
    const resumeWake = await seedQueuedRun({
      companyId,
      agentId,
      issueId: cancelledCard.id,
      createdAt: new Date(base),
      wakeReason: "issue_comment",
      contextExtras: { resumeIntent: true },
    });
    const followUpWake = await seedQueuedRun({
      companyId,
      agentId,
      issueId: cancelledCard.id,
      createdAt: new Date(base + 1000),
      wakeReason: "issue_comment",
      contextExtras: { followUpRequested: true },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await readRun(resumeWake.runId)).toMatchObject({
      status: "cancelled",
      errorCode: "card_closed",
      startedAt: null,
    });
    expect(await readRun(followUpWake.runId)).toMatchObject({
      status: "cancelled",
      errorCode: "card_closed",
      startedAt: null,
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("CR-3: production wake path (on_demand issue_comment with commentId) on a done card dies card_closed, never running", async () => {
    const { companyId, agentId, activeProjectId } = await seedFixture();

    const doneCard = await seedIssue(companyId, agentId, {
      status: "done",
      projectId: activeProjectId,
      createdAt: new Date(),
    });

    const wake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      reason: "issue_comment",
      payload: { issueId: doneCard.id, commentId: randomUUID() },
    });
    expect(wake).not.toBeNull();

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        startedAt: heartbeatRuns.startedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.length).toBe(1);
    expect(runs[0]).toMatchObject({
      status: "cancelled",
      errorCode: "card_closed",
      startedAt: null,
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("test 6: run on closed-project card is cancelled project_closed and does not consume the slot", async () => {
    const { companyId, agentId, activeProjectId, closedProjectId } = await seedFixture();
    const base = Date.now();

    // Blocked run first (older createdAt) — card on the paused project.
    const closedProjectCard = await seedIssue(companyId, agentId, {
      status: "todo",
      projectId: closedProjectId,
      createdAt: new Date(base),
    });
    const blockedRun = await seedQueuedRun({
      companyId,
      agentId,
      issueId: closedProjectCard.id,
      createdAt: new Date(base),
    });

    // Open card on the active project — must get the single slot.
    const openCard = await seedIssue(companyId, agentId, {
      status: "todo",
      projectId: activeProjectId,
      createdAt: new Date(base + 1000),
    });
    const openRun = await seedQueuedRun({
      companyId,
      agentId,
      issueId: openCard.id,
      createdAt: new Date(base + 1000),
    });

    await heartbeat.resumeQueuedRuns();

    const openRunSucceeded = await waitForCondition(async () => {
      const run = await readRun(openRun.runId);
      return run?.status === "succeeded";
    });
    await heartbeat.drainActiveRunExecutions();

    expect(openRunSucceeded).toBe(true);
    expect(await readRun(blockedRun.runId)).toMatchObject({
      status: "cancelled",
      errorCode: "project_closed",
      startedAt: null,
    });
    const blockedWakeup = await readWakeup(blockedRun.wakeupRequestId);
    expect(blockedWakeup).toMatchObject({ status: "cancelled", reason: "project_closed" });
  });

  it("test 5 (non-regression): queued run on an open card in an active project still promotes and runs", async () => {
    const { companyId, agentId, activeProjectId } = await seedFixture();
    const base = Date.now();

    const openCard = await seedIssue(companyId, agentId, {
      status: "todo",
      projectId: activeProjectId,
      createdAt: new Date(base),
    });
    const openRun = await seedQueuedRun({
      companyId,
      agentId,
      issueId: openCard.id,
      createdAt: new Date(base),
    });

    await heartbeat.resumeQueuedRuns();

    const succeeded = await waitForCondition(async () => {
      const run = await readRun(openRun.runId);
      return run?.status === "succeeded";
    });
    await heartbeat.drainActiveRunExecutions();

    expect(succeeded).toBe(true);
    const run = await readRun(openRun.runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.startedAt).not.toBeNull();
    expect(mockAdapterExecute).toHaveBeenCalled();
  });

  it("queued run without a linked wake request is cancelled by the gate with log only", async () => {
    const { companyId, agentId, activeProjectId } = await seedFixture();
    const base = Date.now();

    const cancelledCard = await seedIssue(companyId, agentId, {
      status: "cancelled",
      projectId: activeProjectId,
      createdAt: new Date(base),
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "queued",
      wakeupRequestId: null,
      contextSnapshot: { issueId: cancelledCard.id },
      createdAt: new Date(base),
      updatedAt: new Date(base),
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(await readRun(runId)).toMatchObject({
      status: "cancelled",
      errorCode: "card_closed",
      startedAt: null,
    });
    const wakeups = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId)));
    expect(wakeups.length).toBe(0);
  });
});
