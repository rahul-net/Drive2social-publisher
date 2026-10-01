import { Router } from "express";
import type { ApiResponse } from "@drive2social/shared";

export const healthRouter = Router();

interface HealthPayload {
  service: string;
  version: string;
  time: string;
}

healthRouter.get("/", (_req, res) => {
  const payload: HealthPayload = {
    service: "drive2social-backend",
    version: "0.1.0",
    time: new Date().toISOString(),
  };
  const body: ApiResponse<HealthPayload> = { ok: true, data: payload };
  res.json(body);
});
