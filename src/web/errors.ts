export class WebInputError extends Error {
  readonly code = "invalid_input";
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "WebInputError";
  }
}

export class WebNotFoundError extends Error {
  readonly code = "not_found";
  readonly status = 404;

  constructor(message: string) {
    super(message);
    this.name = "WebNotFoundError";
  }
}

export class WebUnauthorizedError extends Error {
  readonly code = "unauthorized";
  readonly status = 401;

  constructor(message = "authentication required") {
    super(message);
    this.name = "WebUnauthorizedError";
  }
}

export class WebForbiddenError extends Error {
  readonly code = "forbidden";
  readonly status = 403;

  constructor(message = "forbidden") {
    super(message);
    this.name = "WebForbiddenError";
  }
}

export class WebSetupRequiredError extends Error {
  readonly code = "setup_required";
  readonly status = 503;

  constructor() {
    super(
      "Initial admin setup is required. Start required auth with NITELY_ADMIN_EMAIL and NITELY_ADMIN_PASSWORD to bootstrap the first admin.",
    );
    this.name = "WebSetupRequiredError";
  }
}

export function isWebError(
  error: unknown,
): error is { code: string; status: number; message: string } {
  return (
    error instanceof Error &&
    "code" in error &&
    "status" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { status?: unknown }).status === "number"
  );
}
