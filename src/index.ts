import { createApp } from "./app";
import { connect, disconnect } from "./db";
import { describe, env } from "./env";
import { ensureUploadDirs } from "./uploads";
import { warmSuperAdmin } from "./auth/super-admin";
import { sweepDispatch } from "./services/dispatch";

/**
 * Boot.
 *
 * Order matters: configuration, then disk, then the database, and only then
 * does the server listen. Each step fails loudly rather than degrading, because
 * a process that accepts traffic with a broken dependency produces errors that
 * point at the request instead of at the real cause.
 *
 * `ponytail:` run straight from TypeScript with tsx — no build step, no dist to
 * get stale. Swap to a bundled build if process start time or memory on the VPS
 * turns out to matter; typechecking happens in CI either way (`pnpm typecheck`),
 * since tsx strips types without checking them.
 */
async function main(): Promise<void> {
  console.info("[boot] configuration", describe());

  ensureUploadDirs();

  await connect();
  console.info("[boot] mongo connected");

  // Hash the configured super-admin password now, so the first sign-in of the
  // process is not noticeably slower than every later one.
  await warmSuperAdmin();

  /**
   * The dispatch sweep.
   *
   * Expires 30-second offer windows, escalates to a wider radius, and raises
   * the 2-minute no-pro alert. On a timer rather than triggered by requests,
   * because what it enforces is the **passage of time** — a booking nobody
   * looked at still has to escalate.
   *
   * Every 10 seconds: frequent enough that a 30-second window never overruns
   * by much, infrequent enough to be three queries a minute on an idle system.
   *
   * `ponytail:` one timer in one process. Running two of these would double-
   * sweep — harmless today because every write is guarded and idempotent, but
   * the reason to move to a single scheduled worker before scaling out.
   */
  const sweep = setInterval(() => {
    /**
     * Dispatch only.
     *
     * A quotation sweep used to run here too, marking any quotation whose
     * 15 minutes had passed as `rejected`. That was right while the window was
     * an **approval deadline** and became exactly wrong when it became an
     * *edit* window: it deleted a live decision out from under a customer who
     * had simply not got round to it. A quotation with no decision waits, and
     * nothing needs a timer to make that happen.
     */
    void sweepDispatch().catch((err: unknown) => {
      // Logged and swallowed: a failed sweep must not kill the timer, or
      // dispatch silently stops escalating for the life of the process.
      console.error("[dispatch] sweep failed", err);
    });
  }, 10_000);
  sweep.unref();

  const server = createApp().listen(env.port, () => {
    console.info(`[boot] listening on http://localhost:${env.port}`);
  });

  // Finish in-flight requests and close the Mongo connection on a deploy
  // restart. Without this, a `pm2 reload` cuts active requests mid-response.
  const shutdown = (signal: string) => {
    console.info(`[shutdown] ${signal}`);
    clearInterval(sweep);
    server.close(() => {
      void disconnect().then(() => process.exit(0));
    });
    // A request wedged open must not hold the deploy indefinitely.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[boot] failed", err);
  process.exit(1);
});
