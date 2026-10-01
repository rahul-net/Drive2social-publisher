import type { NextFunction, Request, Response } from "express";
import type { ApiResponse } from "@drive2social/shared";
import { ZodError } from "zod";
import { logger } from "../lib/logger.js";

/**
 * Central error handler — always responds with the ApiResponse envelope.
 * Must be registered after all routes.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    // Input validation failure — honest 400, never a 500.
    const body: ApiResponse<never> = {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: err.issues
          .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
          .join("; "),
      },
    };
    res.status(400).json(body);
    return;
  }

  const status =
    err instanceof HttpError ? err.status : 500;
  const message =
    err instanceof Error ? err.message : "Internal server error";

  logger.error({ err, status }, "Unhandled error");

  const body: ApiResponse<never> = {
    ok: false,
    error: {
      code: err instanceof HttpError ? err.code : "INTERNAL_ERROR",
      message: status === 500 ? "Internal server error" : message,
    },
  };
  res.status(status).json(body);
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
