import http from 'http';
import { AddressInfo } from 'net';

import { Server } from 'socket.io';
import { io as connectClient, Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PER_MESSAGE_DEFLATE } from '../socket-compression';

type StringAck = (value: string) => void;

describe('Socket.IO permessage-deflate', () => {
  const payload = 'tool output line\n'.repeat(20_000);
  const clients: ClientSocket[] = [];
  let httpServer: http.Server;
  let io: Server;
  let url: string;

  beforeAll(async () => {
    httpServer = http.createServer();
    io = new Server(httpServer, { perMessageDeflate: PER_MESSAGE_DEFLATE });
    io.on('connection', (socket) => {
      socket.on('echo', (data: string, ack: StringAck) => ack(data));
      socket.on('extensions', (ack: StringAck) => {
        const transport = socket.conn.transport as unknown as { socket?: { extensions?: string } };
        ack(transport.socket?.extensions ?? '');
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    clients.forEach((client) => client.disconnect());
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  const connect = (clientAsksForDeflate: boolean): Promise<ClientSocket> =>
    new Promise((resolve, reject) => {
      const client = connectClient(url, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        perMessageDeflate: (clientAsksForDeflate ? { threshold: 1024 } : false) as { threshold: number },
      });
      clients.push(client);
      client.once('connect', () => resolve(client));
      client.once('connect_error', reject);
    });

  it('compresses for a client that asks for it and delivers identical data', async () => {
    const client = await connect(true);
    expect(await client.emitWithAck('extensions')).toContain('permessage-deflate');
    expect(await client.emitWithAck('echo', payload)).toBe(payload);
  });

  it('stays uncompressed for a client that does not ask and delivers identical data', async () => {
    const client = await connect(false);
    expect(await client.emitWithAck('extensions')).toBe('');
    expect(await client.emitWithAck('echo', payload)).toBe(payload);
  });
});
