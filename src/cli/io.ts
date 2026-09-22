export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export type FetchFunction = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
