import { describe, expect, it } from 'vitest';

import { fillCommandTemplate, getLaravelMajorVersion, isLaravelComposerJson, mapProjectPath } from '../laravel-command';

describe('mapProjectPath', () => {
  it('maps a home-relative path', () => {
    expect(mapProjectPath('/home/u/code/iwd/app', [{ from: '~/code/iwd/', to: '~/code/' }], '/home/u')).toBe('~/code/app');
  });

  it('maps an absolute path rule', () => {
    expect(mapProjectPath('/workspace/project/src', [{ from: '/workspace/project', to: '/mapped/project' }], '/home/u')).toBe('/mapped/project/src');
  });

  it('uses the first matching rule', () => {
    expect(
      mapProjectPath(
        '/home/u/code/iwd/app',
        [
          { from: '~/code/iwd/', to: '~/first/' },
          { from: '~/code/', to: '~/second/' },
        ],
        '/home/u',
      ),
    ).toBe('~/first/app');
  });

  it('does not match a path with a partial directory prefix', () => {
    expect(mapProjectPath('/home/u/code/iwdx/app', [{ from: '~/code/iwd', to: '~/code/' }], '/home/u')).toBe('/home/u/code/iwdx/app');
  });

  it('leaves the path unchanged when there are no rules', () => {
    expect(mapProjectPath('/home/u/code/app', [], '/home/u')).toBe('/home/u/code/app');
  });
});

describe('fillCommandTemplate', () => {
  it('replaces known placeholders and preserves unknown ones', () => {
    expect(fillCommandTemplate('run {command} in {directory} with {other}', { command: 'test', directory: '/app' })).toBe('run test in /app with {other}');
  });

  it('replaces a repeated placeholder everywhere', () => {
    expect(fillCommandTemplate('{command} then {command}', { command: 'build' })).toBe('build then build');
  });
});

describe('getLaravelMajorVersion', () => {
  it('reads Laravel major versions and returns null when unavailable', () => {
    expect(getLaravelMajorVersion('{"packages":[{"name":"laravel/framework","version":"v5.2.45"}]}')).toBe(5);
    expect(getLaravelMajorVersion('{"packages":[{"name":"laravel/framework","version":"v13.6.0"}]}')).toBe(13);
    expect(getLaravelMajorVersion('{"packages":[{"name":"other/pkg","version":"1.0.0"}]}')).toBeNull();
    expect(getLaravelMajorVersion('not json')).toBeNull();
  });
});

describe('isLaravelComposerJson', () => {
  it('recognizes Laravel framework requirements', () => {
    expect(isLaravelComposerJson('{"require":{"laravel/framework":"^13.0"}}')).toBe(true);
  });

  it('rejects non-Laravel composer requirements', () => {
    expect(isLaravelComposerJson('{"require":{"php":"^8.2"}}')).toBe(false);
  });

  it('rejects invalid JSON', () => {
    expect(isLaravelComposerJson('not json')).toBe(false);
  });
});
