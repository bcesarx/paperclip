// INT-465 Gate B — creation-time gate: a closed project (paused_at/archived_at)
// must reject new cards with HTTP 422 on POST /companies/:id/issues and on
// POST /issues/:id/children (project inherited from the parent).
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueCreateIdempotencyKeys,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue project-closed gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue project-closed creation gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-project-closed-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Gate B Co",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedProject(companyId: string, closed: boolean) {
    const [project] = await db
      .insert(projects)
      .values({
        companyId,
        name: closed ? "Paused Project" : "Active Project",
        status: closed ? "completed" : "in_progress",
        pausedAt: closed ? new Date("2026-10-17T12:11:33.940Z") : null,
      })
      .returning();
    return project;
  }

  it("test 3: POST /companies/:id/issues with a paused project returns 422 with exact message", async () => {
    const companyId = await seedCompany();
    const pausedProject = await seedProject(companyId, true);
    const app = createApp();

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Card in paused project", projectId: pausedProject.id })
      .expect(422);

    expect(response.body).toMatchObject({
      error: "projeto encerrado: não criar card (paused_at/archived_at)",
      code: "project_closed",
    });
  });

  it("POST /companies/:id/issues with an archived project returns 422", async () => {
    const companyId = await seedCompany();
    const [archivedProject] = await db
      .insert(projects)
      .values({
        companyId,
        name: "Archived Project",
        status: "completed",
        archivedAt: new Date("2026-10-17T12:11:33.940Z"),
      })
      .returning();
    const app = createApp();

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Card in archived project", projectId: archivedProject.id })
      .expect(422);

    expect(response.body).toMatchObject({
      error: "projeto encerrado: não criar card (paused_at/archived_at)",
      code: "project_closed",
    });
  });

  it("test 4: POST /issues/:id/children inheriting a paused project from the parent returns 422", async () => {
    const companyId = await seedCompany();
    const pausedProject = await seedProject(companyId, true);
    const [parent] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Parent in paused project",
        status: "todo",
        priority: "medium",
        projectId: pausedProject.id,
      })
      .returning();
    const app = createApp();

    const response = await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .send({ title: "Child inheriting paused project" })
      .expect(422);

    expect(response.body).toMatchObject({
      error: "projeto encerrado: não criar card (paused_at/archived_at)",
      code: "project_closed",
    });
  });

  it("test 5 (non-regression): card in an active project is created normally (201)", async () => {
    const companyId = await seedCompany();
    const activeProject = await seedProject(companyId, false);
    const app = createApp();

    const response = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Card in active project", projectId: activeProject.id })
      .expect(201);

    expect(response.body).toMatchObject({
      title: "Card in active project",
      projectId: activeProject.id,
    });
  });

  it("test 5 (non-regression): child in an active project (inherited) is created normally (201)", async () => {
    const companyId = await seedCompany();
    const activeProject = await seedProject(companyId, false);
    const [parent] = await db
      .insert(issues)
      .values({
        companyId,
        title: "Parent in active project",
        status: "todo",
        priority: "medium",
        projectId: activeProject.id,
      })
      .returning();
    const app = createApp();

    const response = await request(app)
      .post(`/api/issues/${parent.id}/children`)
      .send({ title: "Child inheriting active project" })
      .expect(201);

    expect(response.body).toMatchObject({
      title: "Child inheriting active project",
      projectId: activeProject.id,
      parentId: parent.id,
    });
  });
});
