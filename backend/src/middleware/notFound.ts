import type { Request, Response } from "express";
import type { ApiResponse } from "@drive2social/shared";

/** 404 fallback for unknown API routes. Register after all routers. */
export function notFound(_req: Request, res: Response): void {
  const body: ApiResponse<never> = {
    ok: false,
    error: { code: "NOT_FOUND", message: "Route not found" },
  };
  res.status(404).json(body);
}
