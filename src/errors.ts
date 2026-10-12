export class HarnessError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HarnessError";
  }
}

export function fail(code: string, message: string): never {
  throw new HarnessError(code, message);
}

export function throwCollected(errors: unknown[], message: string): void {
  if (errors.length) throw new AggregateError(errors, message);
}
