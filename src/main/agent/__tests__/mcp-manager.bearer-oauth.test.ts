import { describe, it, expect, vi } from 'vitest';
import { McpOAuthStatus } from '@common/types';

import { McpManager } from '../mcp-manager';

import type { McpOAuthManager } from '../mcp-oauth-manager';
import type { McpServerConfig } from '@common/types';

const createManager = () => {
  const oauthManager = {
    getStatus: vi.fn().mockResolvedValue({ status: McpOAuthStatus.AuthenticationRequired }),
    getProvider: vi.fn(),
    getMcpSdkProvider: vi.fn(),
  };
  const manager = new McpManager(oauthManager as unknown as McpOAuthManager);

  return { manager, oauthManager };
};

describe('McpManager Authorization header OAuth bypass', () => {
  const url = 'https://example.test/mcp';

  it.each(['Authorization', 'authorization', 'aUtHoRiZaTiOn'])('does not check OAuth status with an %s header', async (header) => {
    const { manager, oauthManager } = createManager();
    const config: McpServerConfig = { url, headers: { [header]: 'Bearer x' } };

    expect(await manager.getOAuthStatus(config)).toEqual({ status: McpOAuthStatus.NotRequired });
    expect(oauthManager.getStatus).not.toHaveBeenCalled();
    expect(oauthManager.getProvider).not.toHaveBeenCalled();
    expect(oauthManager.getMcpSdkProvider).not.toHaveBeenCalled();
  });

  it('delegates to OAuth status for a URL without headers', async () => {
    const { manager, oauthManager } = createManager();

    expect(await manager.getOAuthStatus({ url })).toEqual({ status: McpOAuthStatus.AuthenticationRequired });
    expect(oauthManager.getStatus).toHaveBeenCalledExactlyOnceWith(url);
  });

  it('delegates to OAuth status for headers without Authorization', async () => {
    const { manager, oauthManager } = createManager();

    expect(await manager.getOAuthStatus({ url, headers: { 'X-Api-Key': 'example' } })).toEqual({
      status: McpOAuthStatus.AuthenticationRequired,
    });
    expect(oauthManager.getStatus).toHaveBeenCalledExactlyOnceWith(url);
  });
});
