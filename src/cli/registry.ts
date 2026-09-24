export interface CliCommand<Context> {
  /** The `argv[0]` this command answers to. */
  name: string;
  /** Help lines for this command, in the order they appear in `nitely help`. */
  usage: string[];
  /**
   * Optional guard for a more specific form of `name`, such as `run watch`
   * beside the general `run <flow>`. Guarded forms are always preferred over an
   * unguarded form of the same name.
   */
  matches?: (argv: string[]) => boolean;
  run: (context: Context) => Promise<number>;
}

export function buildCliHelp<Context>(
  header: string,
  commands: readonly CliCommand<Context>[],
): string {
  return [header, "", "Commands:", ...commands.flatMap((command) => command.usage)].join(
    "\n",
  );
}

export function selectCliCommand<Context>(
  commands: readonly CliCommand<Context>[],
  argv: string[],
): CliCommand<Context> | undefined {
  const candidates = commands.filter((command) => command.name === argv[0]);
  return (
    candidates.find((command) => command.matches?.(argv) === true) ??
    candidates.find((command) => !command.matches)
  );
}
