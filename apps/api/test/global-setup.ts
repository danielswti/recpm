import { createTestDatabase, dropTestDatabase, type TestDbUrls } from "@recpm/db/testing";
import type { TestProject } from "vitest/node";

export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  if (!adminUrl) throw new Error("Defina TEST_PG_ADMIN_URL (superusuário do Postgres de teste)");
  const db = await createTestDatabase(adminUrl);
  project.provide("db", db);
  return () => dropTestDatabase(adminUrl, db.name);
}

declare module "vitest" {
  export interface ProvidedContext {
    db: TestDbUrls;
  }
}
