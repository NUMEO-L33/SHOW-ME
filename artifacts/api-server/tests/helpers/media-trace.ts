import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

/** Test-only observation. Never record arguments, paths, stderr, pixels or environment values. */
export function traceMediaProcess(context: TestContext) {
  const start = performance.now();
  const events: { event: string; ms: number }[] = [];
  const processes: { started: boolean; inputFinished: boolean; outputBytes: number;
    outputEnded: boolean; exitCode: number | null; exited: boolean; closed: boolean }[] = [];
  const mark = (event: string) => {
    if (events.length < 64) events.push({ event, ms: Math.round(performance.now() - start) });
  };
  const original = childProcess.spawn;
  const traced = context.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
    const index = processes.length;
    const state = { started: false, inputFinished: false, outputBytes: 0, outputEnded: false,
      exitCode: null as number | null, exited: false, closed: false };
    processes.push(state);
    mark(`decoder-${index}:spawn`);
    const child: ChildProcess = Reflect.apply(original, childProcess, args);
    child.once("spawn", () => { state.started = true; mark(`decoder-${index}:started`); });
    child.once("error", () => mark(`decoder-${index}:error`));
    child.stdin?.once("finish", () => { state.inputFinished = true; mark(`decoder-${index}:input-finished`); });
    child.stdin?.once("error", () => mark(`decoder-${index}:input-error`));
    child.stdout?.on("data", (chunk: Buffer) => { state.outputBytes += chunk.length; });
    child.stdout?.once("end", () => { state.outputEnded = true; mark(`decoder-${index}:output-ended`); });
    child.stdout?.once("error", () => mark(`decoder-${index}:output-error`));
    child.once("exit", (code) => { state.exited = true; state.exitCode = code; mark(`decoder-${index}:exit`); });
    child.once("close", () => { state.closed = true; mark(`decoder-${index}:closed`); });
    return child;
  });
  syncBuiltinESMExports();
  context.after(() => { traced.mock.restore(); syncBuiltinESMExports(); });
  return { mark, snapshot: () => ({ events: [...events], processes: processes.map((state) => ({ ...state })) }) };
}
