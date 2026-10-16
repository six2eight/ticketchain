/** An error that maps to a JSON API response `{ error: { code, message } }`. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`, 404);
export const forbidden = (message = "Forbidden") => new AppError("FORBIDDEN", message, 403);
export const unauthorized = (message = "Authentication required") =>
  new AppError("UNAUTHORIZED", message, 401);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
