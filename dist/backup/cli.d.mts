#!/usr/bin/env node
interface Args {
    command: string;
    in?: string;
    out?: string;
    checksum?: string;
    keyFile?: string;
    toDatabase: boolean;
}
declare function parseArgs(argv: string[]): Args;
declare function resolveKey(args: Args, env: NodeJS.ProcessEnv): string;
declare function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number>;

export { main, parseArgs, resolveKey };
