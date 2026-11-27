import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../types";
import { errorBody } from "./errors";

/** Sub-roteador com o mesmo formato de erro de validação do app principal. */
export const router = () =>
  new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success)
        return c.json(errorBody("VALIDATION", "Dados inválidos.", { issues: result.error.issues }), 400);
    },
  });
