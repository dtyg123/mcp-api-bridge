export class ToolArgumentError extends Error {}

export class UpstreamError extends Error {
  readonly detail?: unknown;
  constructor(message: string, detail?: unknown) {
    super(message);
    this.detail = detail;
  }
}
