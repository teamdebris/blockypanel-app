export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export class BadRequestError extends HttpError {
  /** `field` names the form input at fault, so the UI can highlight it. */
  readonly field?: string;
  constructor(message: string, field?: string) { super(400, message); this.field = field; }
}

export class NotFoundError extends HttpError {
  constructor(message: string) { super(404, message); }
}

export class ConflictError extends HttpError {
  constructor(message: string) { super(409, message); }
}
