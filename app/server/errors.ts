export type DomainErrorCode =
  | "NOT_FOUND"
  | "INVALID_STATE"
  | "RATE_LIMITED"
  | "INVALID_FILE"
  | "INVALID_INPUT"
  | "BUSY";

export class DomainError extends Error {
  constructor(
    public code: DomainErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DomainError";
  }
}
