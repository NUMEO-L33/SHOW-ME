import childProcess, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

/** Hold only completion notification; native FFmpeg, its bytes and exit code stay real. */
export function holdDecoderCompletion(context: TestContext) {
  const original = childProcess.spawn;
  let completed!: (value: { code: number | null; outputBytes: number }) => void;
  const nativeClosed = new Promise<{ code: number | null; outputBytes: number }>((resolve) => { completed = resolve; });
  let release = () => {};
  let calls = 0;
  const restoreChildren: Array<() => void> = [];
  const patched = context.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
    calls++;
    const child: ChildProcess = Reflect.apply(original, childProcess, args);
    const emit = child.emit;
    let outputBytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => { outputBytes += chunk.length; });
    child.emit = function (event: string | symbol, ...values: unknown[]) {
      if (event !== "close") return Reflect.apply(emit, this, [event, ...values]);
      let released = false;
      release = () => {
        if (released) return;
        released = true;
        Reflect.apply(emit, child, [event, ...values]);
      };
      completed({ code: values[0] as number | null, outputBytes });
      return true;
    };
    restoreChildren.push(() => {
      child.emit = emit;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    return child;
  });
  syncBuiltinESMExports();
  const restore = () => { patched.mock.restore(); syncBuiltinESMExports(); };
  context.after(() => { release(); restoreChildren.forEach((restoreChild) => restoreChild()); restore(); });
  return { nativeClosed, release: () => release(), restore, calls: () => calls };
}
