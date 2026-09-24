export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export class BadRequestError extends HttpError {
  /** `field` names the form input at fault, so the UI can highlight it. */
  constructor(message: string, readonly field?: string) { super(400, message); }
}

export class NotFoundError extends HttpError {
  constructor(message: string) { super(404, message); }
}

export class ConflictError extends HttpError {
  constructor(message: string) { super(409, message); }
}
