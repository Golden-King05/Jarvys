import type { NextFunction, Request, Response } from "express";

// Express 4 doesn't catch a rejected promise from an async route handler —
// it becomes an unhandled rejection and crashes the whole process. Confirmed
// in production: a connection timeout to OpenSky in the /flights route took
// the entire server down repeatedly, taking every other endpoint with it
// until Render restarted it. This forwards any such rejection to Express's
// own error-handling middleware (registered in index.ts) instead, so one
// route's external-API hiccup returns a clean error response rather than
// crashing the server for everyone.
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Req, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
