import mongoose from "mongoose";
import { env } from "./env";

/**
 * The Mongo connection.
 *
 * One connection for the process, opened at boot and awaited before the server
 * listens — a server that accepts requests before its database is reachable
 * answers the first few with a 500 for no reason a caller can act on.
 */
export async function connect(dbName?: string): Promise<void> {
  mongoose.set("strictQuery", true);

  // Mongoose buffers commands for 10s by default when disconnected, which turns
  // a dead database into a pile of slow requests rather than a clear failure.
  await mongoose.connect(env.mongoUri, {
    serverSelectionTimeoutMS: 10_000,
    // Overrides the database named in the URI, leaving the credentials and
    // host alone. Only the self-check passes this, so that a suite which
    // deletes bookings and overwrites platform settings cannot reach real
    // data — see SELFCHECK_DB in selfcheck.ts.
    ...(dbName === undefined ? {} : { dbName }),
  });

  // Atlas drops idle connections and reconnects; log both so an intermittent
  // network problem is visible rather than showing up only as odd latency.
  mongoose.connection.on("disconnected", () =>
    console.warn("[db] disconnected"),
  );
  mongoose.connection.on("reconnected", () => console.info("[db] reconnected"));
}

export async function disconnect(): Promise<void> {
  await mongoose.disconnect();
}
