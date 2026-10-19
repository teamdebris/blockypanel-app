export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function errorStatus(error: unknown) {
  if (error instanceof HttpError) return error.status;
  if (error instanceof Error && error.name === "ArchiveError") return 400;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return 404;
  if (code === "EEXIST" || code === "EBUSY" || code === "EPERM") return 409;
  return 500;
}
