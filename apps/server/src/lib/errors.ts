export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resursen') => new AppError(404, 'not_found', `${what} hittades inte`);
export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const forbidden = (message = 'Åtkomst nekad') => new AppError(403, 'forbidden', message);
export const unauthorized = (message = 'Inte inloggad') => new AppError(401, 'unauthorized', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
