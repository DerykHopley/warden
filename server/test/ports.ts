import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A proxy to `target` on 127.0.0.1 that hands every connection to `whileClosed` until `open()`, then passes them
 * through. By default it hangs up: a database that can't be reached at first, then can. */
export async function gatedProxy(
  target: number,
  { whileClosed = (socket: Socket) => void socket.destroy() } = {},
) {
  let open = false;
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    if (!open) return whileClosed(socket);
    const upstream = connect(target, "127.0.0.1");
    sockets.push(upstream);
    socket.pipe(upstream).pipe(socket);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    open: () => {
      open = true;
    },
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A gatedProxy to Postgres on `target` that answers each login as a Postgres still starting up does (FATAL 57P03)
 * until `open()`. `refused()` counts the logins it answered so. */
export async function startingUpPostgres(target: number) {
  let refused = 0;
  const startingUp = fatalError("57P03", "the database system is starting up");
  const proxy = await gatedProxy(target, {
    // After the client's startup message, as Postgres answers it.
    whileClosed: (socket) =>
      void socket.once("data", () => {
        refused += 1;
        socket.end(startingUp);
      }),
  });
  return { ...proxy, refused: () => refused };
}

/** A Postgres ErrorResponse message: a FATAL error with `code` and `message`, as Postgres answers a login it refuses. */
function fatalError(code: string, message: string): Buffer {
  const fields = ["SFATAL", "VFATAL", `C${code}`, `M${message}`];
  const body = Buffer.from(fields.map((field) => `${field}\0`).join("") + "\0");
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  return Buffer.concat([Buffer.from("E"), length, body]);
}

/** A stand-in Postgres on a Unix socket for `port`, in a new folder of its own: PGHOST set to `host` (and PGPORT to
 * `port`) reaches it, never a real Postgres. It refuses every login (FATAL 28000), so a connection fails at once.
 * `logins()` counts the logins it refused. */
export async function socketPostgres(port: string) {
  const host = await mkdtemp(join(tmpdir(), "warden-pg-"));
  let logins = 0;
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.once("data", () => {
      logins += 1;
      socket.end(fatalError("28000", "the stand-in Postgres refuses every login"));
    });
  });
  await new Promise<void>((resolve) => server.listen(join(host, `.s.PGSQL.${port}`), resolve));
  return {
    host,
    logins: () => logins,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
      await rm(host, { recursive: true, force: true });
    },
  };
}

/** A port nothing listens on: bound, read, and released. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A server that accepts connections and never answers: a database that can't be reached in time. */
export async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
