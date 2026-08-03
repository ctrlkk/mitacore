import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import { buffer, text } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: Blob | ReadableStream<Uint8Array> | Uint8Array | string;
  signal?: AbortSignal;
}

export interface SpawnResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
}

function createInputStream(input: NonNullable<SpawnOptions["stdin"]>): Readable {
  if (typeof input === "string" || input instanceof Uint8Array) return Readable.from([input]);

  const stream = input instanceof Blob ? input.stream() : input;
  return Readable.from(
    (async function* () {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    })(),
  );
}

export async function spawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const input = options.stdin
    ? pipeline(createInputStream(options.stdin), child.stdin)
    : Promise.resolve(child.stdin.end());
  const output = buffer(child.stdout);
  const errors = text(child.stderr);
  const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  const [inputResult, outputResult, errorsResult, closeResult] = await Promise.allSettled([
    input,
    output,
    errors,
    closed,
  ]);

  if (closeResult.status === "rejected") throw closeResult.reason;
  if (outputResult.status === "rejected") throw outputResult.reason;
  if (errorsResult.status === "rejected") throw errorsResult.reason;

  const { exitCode, signal } = closeResult.value;
  if (inputResult.status === "rejected" && exitCode === 0) throw inputResult.reason;

  return {
    exitCode,
    signal,
    stdout: outputResult.value,
    stderr: errorsResult.value,
  };
}
