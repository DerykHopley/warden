import { connect, createServer, type Server, type Socket } from "node:net";

/** A proxy to `target` on 127.0.0.1 that hangs up on every connection until `open()`: a database that can't be
 * reached at first, then can. */
export async function gatedProxy(target: number) {
  let open = false;
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    if (!open) return socket.destroy();
    const upstream = connect(target, "127.0.0.1");
    sockets.push(socket, upstream);
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
