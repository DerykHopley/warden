import { connect, createServer, type Server, type Socket } from "node:net";

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
  const fields = ["SFATAL", "VFATAL", "C57P03", "Mthe database system is starting up"];
  const body = Buffer.from(fields.map((field) => `${field}\0`).join("") + "\0");
  const length = Buffer.alloc(4);
  length.writeInt32BE(body.length + 4);
  const startingUp = Buffer.concat([Buffer.from("E"), length, body]);
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
