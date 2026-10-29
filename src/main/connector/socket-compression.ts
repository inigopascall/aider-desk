import type { ServerOptions } from 'socket.io';

/**
 * WebSocket permessage-deflate settings for the Socket.IO server.
 * Only clients that ask for compression get it; any other client carries on uncompressed.
 * Messages under 1 KB are sent as they are, and no compression history is kept between
 * messages, which keeps the memory cost per connection low.
 */
export const PER_MESSAGE_DEFLATE: ServerOptions['perMessageDeflate'] = {
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
};
